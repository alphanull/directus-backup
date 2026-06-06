/**
 * Backup/restore coordination: Directus container lifecycle via Docker,
 * run.sh (the runner) execution via child_process.spawn().
 * @author   Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

/** @typedef {{ database?: boolean, assets?: boolean, extensions?: boolean, includedCollections?: string[], excludedCollections?: string[] }} ManifestScope */
/** @typedef {Record<string, unknown> & { id: string, status: string, scope?: ManifestScope }} Manifest */

import { join, resolve as resolvePath } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { docker, ctx } from './context.js';
import { notifyAdmins, fetchDirectusVersion } from './notify.js';
import { appendActivity } from './activity.js';

import {
    readConfig,
    readManifest,
    readAllManifests,
    writeManifest,
    readAllLocks,
    acquireLock,
    releaseLock,
    checkQuota,
    rotateForSpace,
    dirSizeBytes,
    parseVerifyData,
    parseRestoreVerify,
    parseRestoreResult,
    enforceRetention
} from './storage.js';

import {
    BACKUP_DIR,
    UPLOADS_DIR,
    EXTENSIONS_DIR,
    DIRECTUS_CONTAINER,
    DIRECTUS_URL,
    DB_ADAPTER,
    BACKUP_DUMP_FORMAT,
    DB_HOST,
    DB_USER,
    DB_PASSWORD,
    DB_DATABASE,
    CACHE_HOST,
    CACHE_PORT,
    CACHE_DB,
    BACKUP_ID_RE,
    LIVE_DB,
    RUNNER_TIMEOUT_MS,
    HOOK_POST_RESTORE_URL,
    HOOK_POST_RESTORE_SECRET,
    HOOK_POST_RESTORE_HINT
} from './config.js';

// ── Directus discovery ────────────────────────────────────────

/**
 * Finds the Directus container — first by the configured name (works with
 * standard Docker Compose naming), falling back to a label-based search
 * (works with Coolify and other container orchestrators that rename containers).
 * @returns {Promise<import('dockerode').Container>} The discovered Directus container.
 */
async function findDirectusContainer() {
    try {
        const c = docker.getContainer(DIRECTUS_CONTAINER);
        await c.inspect();
        console.log(`Found Directus container by name: ${DIRECTUS_CONTAINER}`);
        return c;
    } catch { /* not found by name — try by label */ }

    const containers = await docker.listContainers({
        filters: JSON.stringify({
            label: ['com.docker.compose.service=directus'],
            status: ['running']
        })
    });

    if (containers.length === 0) {
        throw new Error(`Directus container not found (tried name "${DIRECTUS_CONTAINER}" and label search)`);
    }

    const name = containers[0].Names?.[0]?.replace(/^\//, '') ?? containers[0].Id;
    console.log(`Found Directus container by label: ${name}`);
    return docker.getContainer(containers[0].Id);
}

/**
 * Discovers the Directus container and stores its ID for stop/start during restore.
 * Must be called once before the HTTP server starts accepting requests.
 */
export async function discoverDirectus() {
    try {
        const directus = await findDirectusContainer();
        const dInfo = await directus.inspect();
        ctx.directusContainerId = dInfo.Id;
        console.log(`Directus container: ${dInfo.Name} (${dInfo.Id.slice(0, 12)})`);
    } catch (e) {
        console.warn('Could not find/inspect Directus container:', /** @type {Error} */ (e).message);
    }
}

// ── Cancellation registry ─────────────────────────────────────

/**
 * Maps a running backup ID to a function that sends SIGTERM to its process
 * group. Populated by spawnRunner() immediately after spawn and cleared on
 * child close. Only backup runs register here; restore runs use the same
 * spawnRunner() path but BACKUP_ID is not set for them, so they are excluded.
 * @type {Map<string, () => void>}
 */
const activeKillFns = new Map();

/**
 * Backup IDs for which cancelBackup() was called while the process was still
 * alive. The monitorProcess() function reads and clears this set on exit to
 * distinguish a deliberate cancellation from an ordinary failure.
 * @type {Set<string>}
 */
const cancelledIds = new Set();

/**
 * Signals the process group of a running backup to terminate gracefully.
 * Sets the cancellation flag so monitorProcess() can clean up the partial
 * backup directory instead of writing a failed manifest.
 * @param   {string}  backupId  The backup ID to cancel.
 * @returns {boolean}           `true` if a running process was found and signalled, `false` otherwise.
 */
export function cancelBackup(backupId) {
    const kill = activeKillFns.get(backupId);
    if (!kill) return false;
    cancelledIds.add(backupId);
    kill();
    return true;
}

// ── Runner helpers ────────────────────────────────────────────

/**
 * Builds the environment variables passed to the run.sh child process.
 * @param   {'backup'|'restore'}     mode        Selects whether the runner performs a backup or a restore.
 * @param   {string}                 backupId    Timestamped ID of the backup directory.
 * @param   {string}                 backupPath  Absolute path to the backup directory.
 * @param   {string}                 dumpFormat  `'custom'` or `'plain'`.
 * @param   {string[]}               [scopeEnv]  Extra scope env vars (e.g. BACKUP_INCLUDE_DB=1).
 * @returns {Record<string, string>}             Environment variables for the run.sh child process.
 */
function buildRunnerEnv(mode, backupId, backupPath, dumpFormat, scopeEnv) {
    /** @type {Record<string, string>} */
    const env = {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        RUNNER_MODE: mode,
        BACKUP_ID: backupId,
        BACKUP_PATH: backupPath,
        BACKUP_DUMP_FORMAT: dumpFormat,
        DB_ADAPTER,
        DB_HOST,
        DB_USER,
        DB_PASSWORD,
        DB_DATABASE,
        UPLOADS_DIR,
        EXTENSIONS_DIR
    };
    for (const entry of scopeEnv || []) {
        const eq = entry.indexOf('=');
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
}

/**
 * Converts a scope config object into env-var strings for the runner.
 *
 * Supports two scope formats:
 * - `includeCollections` (per-run scope): explicit allowlist → `INCLUDE_TABLES`.
 * - `excludedCollections` (global config scope): blocklist → `EXCLUDE_TABLES`.
 * New collections not in the blocklist are automatically included by pg_dump.
 * @param   {'backup'|'restore'}                                                                                                         mode   Runner mode; selects the `BACKUP_`/`RESTORE_` env prefix.
 * @param   {{ database: boolean, assets: boolean, extensions: boolean, includeCollections?: string[], excludedCollections?: string[] }} scope  Scope config to convert.
 * @returns {string[]}                                                                                                                          Scope env-var strings for the runner.
 */
function buildScopeEnv(mode, scope) {
    const prefix = mode === 'backup' ? 'BACKUP' : 'RESTORE';
    const envs = [
        `${prefix}_INCLUDE_DB=${scope.database ? '1' : '0'}`,
        `${prefix}_INCLUDE_ASSETS=${scope.assets ? '1' : '0'}`,
        `${prefix}_INCLUDE_EXTENSIONS=${scope.extensions ? '1' : '0'}`
    ];
    if (scope.excludedCollections && scope.excludedCollections.length > 0) {
        // Blocklist path (global config scope): pg_dump --exclude-table=... for each entry.
        // Empty excludedCollections ([]) means nothing is excluded — falls through to the else branch.
        envs.push(`${prefix}_EXCLUDE_TABLES=${scope.excludedCollections.join(',')}`);
        envs.push(`${prefix}_INCLUDE_TABLES=`);
    } else {
        // Allowlist path or no-filter: pg_dump --table=... for each entry.
        // Empty includeCollections ([]) means no filter → pg_dump dumps all tables.
        envs.push(`${prefix}_INCLUDE_TABLES=${(scope.includeCollections || []).join(',')}`);
        envs.push(`${prefix}_EXCLUDE_TABLES=`);
    }
    return envs;
}

/**
 * Spawns run.sh as a child process and pipes stdout+stderr to a log file.
 * The child is started as a process-group leader (`detached`) so that a timeout
 * can terminate the entire tree. Killing only `run.sh` would orphan its
 * children, such as a `pg_dump` blocked on a lock wait, which would keep
 * running. On timeout the group receives SIGTERM, escalated to SIGKILL after a
 * short grace period, and the promise resolves with a non-zero exit code so
 * callers treat it as a failure.
 * @param   {Record<string, string>}                           env               Environment variables for the child process.
 * @param   {string}                                           logPath           Absolute path to the log file.
 * @param   {Object}                                           [opts]            Overrides, mainly for tests.
 * @param   {number}                                           [opts.timeoutMs]  Kill the child after this many ms; 0 disables.
 * @param   {string}                                           [opts.command]    Executable to spawn.
 * @param   {string[]}                                         [opts.args]       Arguments passed to the executable.
 * @returns {Promise<{ exitCode: number, timedOut: boolean }>}                   Exit code and whether the timeout fired.
 */
export function spawnRunner(env, logPath, { timeoutMs = RUNNER_TIMEOUT_MS, command = '/app/run.sh', args = [] } = {}) {
    return new Promise((resolve, reject) => {
        const logStream = createWriteStream(logPath, { flags: 'a' });
        const child = spawn(command, args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        });

        child.stdout.pipe(logStream);
        child.stderr.pipe(logStream);

        let timedOut = false;
        /** @type {ReturnType<typeof setTimeout>|null} */
        let killTimer = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        let escalateTimer = null;

        /**
         * Signals the whole process group (negative PID), falling back to the
         * child alone if the group signal fails because the PID is already gone.
         * @param {NodeJS.Signals} signal  Signal to send to the process group.
         */
        const killGroup = signal => {
            if (child.pid === undefined) return;
            try {
                process.kill(-child.pid, signal);
            } catch {
                try {
                    child.kill(signal);
                } catch { /* already exited */ }
            }
        };

        // Register the kill function so an in-flight cancel request can reach
        // this process group. Only registered when BACKUP_ID is present (backup
        // runs); restore runs do not set BACKUP_ID and are intentionally excluded.
        // Placed after killGroup is defined so the closure is immediately valid.
        const runBackupId = env.BACKUP_ID;
        if (runBackupId) activeKillFns.set(runBackupId, () => killGroup('SIGTERM'));

        if (timeoutMs > 0) {
            killTimer = setTimeout(() => {
                timedOut = true;
                logStream.write(`\n[runner] Aborted: exceeded timeout of ${Math.round(timeoutMs / 1000)}s — terminating process group\n`);
                killGroup('SIGTERM');
                escalateTimer = setTimeout(() => killGroup('SIGKILL'), 10_000);
            }, timeoutMs);
        }

        child.on('close', code => {
            if (runBackupId) activeKillFns.delete(runBackupId);
            if (killTimer) clearTimeout(killTimer);
            if (escalateTimer) clearTimeout(escalateTimer);
            logStream.end();
            resolve({ exitCode: timedOut ? code ?? 124 : code ?? 1, timedOut });
        });

        child.on('error', err => {
            if (killTimer) clearTimeout(killTimer);
            if (escalateTimer) clearTimeout(escalateTimer);
            logStream.end();
            reject(err);
        });
    });
}

/**
 * Flushes the Directus Redis cache by sending a raw `FLUSHDB` command over TCP
 * (preceded by `SELECT` when `CACHE_DB > 0`). Only the configured database is
 * cleared, so a Redis instance shared with other applications is left intact.
 * Called after every successful restore so Directus starts with a clean
 * permission cache rather than serving stale pre-restore data.
 *
 * No-op when `host` is empty: setups without Redis (no cache, or an
 * in-memory cache that the Directus container restart already clears) have
 * nothing to flush.
 *
 * Connection target defaults to the configured `CACHE_*` values; parameters
 * exist so the behaviour can be exercised in isolation.
 * @param   {{ host?: string, port?: number, db?: number }} [opts]  Connection overrides; defaults to the configured `CACHE_*` values.
 * @returns {Promise<void>}
 */
export function flushCache({ host = CACHE_HOST, port = CACHE_PORT, db = CACHE_DB } = {}) {
    if (!host) {
        console.log('Restore: cache flush skipped (CACHE_HOST not set)');
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        /** @type {string[]} */
        const commands = [];
        if (db > 0) {
            const dbStr = String(db);
            commands.push(`*2\r\n$6\r\nSELECT\r\n$${dbStr.length}\r\n${dbStr}\r\n`);
        }
        commands.push('*1\r\n$7\r\nFLUSHDB\r\n');
        const expectedReplies = commands.length;

        const client = createConnection({ host, port });
        client.setTimeout(3000);
        client.once('connect', () => client.write(commands.join('')));

        let buffer = '';
        client.on('data', chunk => {
            buffer += chunk.toString();
            // Each RESP reply is terminated by CRLF; resolve once all are in.
            if ((buffer.match(/\r\n/g) || []).length >= expectedReplies) {
                client.destroy();
                console.log('Restore: Redis cache flushed');
                resolve();
            }
        });
        client.once('timeout', () => {
            client.destroy(); reject(new Error('Redis flush timeout'));
        });
        client.once('error', reject);
    });
}

/**
 * Waits for Directus to be ready by polling the health endpoint.
 * @param   {number}        maxWaitMs  Maximum time to wait in milliseconds.
 * @returns {Promise<void>}
 */
async function waitForDirectus(maxWaitMs = 60000) {
    const startTime = Date.now();
    const pollInterval = 2000;

    console.log('Waiting for Directus to be ready...');

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const response = await fetch(`${DIRECTUS_URL}/server/health`, {
                signal: AbortSignal.timeout(3000)
            });
            if (response.ok) {
                console.log(`Directus ready after ${Math.round((Date.now() - startTime) / 1000)}s`);
                return;
            }
        } catch {
            // Directus not ready yet
        }
        await new Promise(resolve => { setTimeout(resolve, pollInterval); });
    }

    throw new Error(`Directus did not become ready within ${maxWaitMs / 1000}s`);
}

/**
 * Fires the post-restore hook webhook if configured.
 * @param   {string}        backupId  Backup ID for logging and notifications.
 * @returns {Promise<void>}
 */
async function triggerPostRestoreHook(backupId) {
    if (!HOOK_POST_RESTORE_URL) return;

    try {
        await waitForDirectus();

        console.log(`Post-restore hook: ${HOOK_POST_RESTORE_URL}`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

        const response = await fetch(HOOK_POST_RESTORE_URL, {
            method: 'POST',
            headers: {
                ...HOOK_POST_RESTORE_SECRET && { 'X-Webhook-Secret': HOOK_POST_RESTORE_SECRET }
            },
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`Hook returned ${response.status}: ${errorText}`);
        }

        console.log('Post-restore hook completed successfully');
    } catch (error) {
        const err = /** @type {Error} */ (error);
        const errorMsg = err.name === 'AbortError'
            ? 'Post-restore hook timed out after 5 minutes'
            : err.message;

        console.error('Post-restore hook failed:', errorMsg);

        const hint = HOOK_POST_RESTORE_HINT
            ? `\n\nRecovery: ${HOOK_POST_RESTORE_HINT}`
            : '';

        notifyAdmins(
            'Restore completed but post-restore hook failed',
            `Backup ${backupId} was restored successfully, but the post-restore hook failed.\n\nError: ${errorMsg}${hint}`
        ).catch(() => {});
    }
}

// ── Runner lifecycle ──────────────────────────────────────────

/**
 * Monitors a backup child process. Fire-and-forget: called after spawn,
 * resolves internally when the process exits.
 *
 * On success: writes `status: success`, size, and verify data to the manifest,
 * then enforces retention (scheduled backups) or sends a failure notification.
 * @param {Promise<{ exitCode: number }>} runnerPromise  Resolves when the spawned runner exits.
 * @param {string}                        backupId       Backup ID being monitored.
 * @param {string}                        source         `'manual'` or `'scheduled'`.
 */
export function monitorProcess(runnerPromise, backupId, source) {
    const dir = join(BACKUP_DIR, backupId);

    runnerPromise
        .then(async({ exitCode: code }) => {
            console.log(`Runner exited: ${backupId} code=${code}`);
            const finishedAt = new Date().toISOString();

            const cancelled = cancelledIds.has(backupId);
            cancelledIds.delete(backupId);

            if (cancelled) {
                console.log(`Backup cancelled: ${backupId} — removing partial directory`);
                try {
                    await rm(dir, { recursive: true, force: true });
                } catch (e) {
                    console.warn(`Could not remove cancelled backup directory ${backupId}:`, /** @type {Error} */ (e).message);
                }
                await releaseLock(LIVE_DB);
                console.log(`Lock released: ${backupId} (cancelled)`);
                appendActivity({ action: 'backup_cancelled', backupId, source }).catch(() => {});
                return;
            }

            const manifest = /** @type {Manifest} */ (await readManifest(dir) || {
                id: backupId,
                createdAt: finishedAt,
                label: backupId.split('__')[2] || 'unknown',
                source: source || 'manual',
                status: 'running',
                tool: { name: DB_ADAPTER }
            });

            manifest.status = code === 0 ? 'success' : 'failed';
            manifest.finishedAt = finishedAt;
            if (code === 0) {
                delete manifest.error;
                try {
                    manifest.sizeBytes = await dirSizeBytes(dir);
                } catch (e) {
                    console.warn(`Could not calculate size for ${backupId}:`, /** @type {Error} */ (e).message);
                }
                try {
                    const { collections, ...verify } = await parseVerifyData(dir);
                    manifest.verify = verify;
                    // Positive index: which collections are actually in the dump.
                    // Lets the restore UI show exactly the backup contents without
                    // comparing against the (possibly diverged) live schema.
                    if (manifest.scope && Array.isArray(collections)) {
                        /** @type {{ collections?: string[] }} */ (manifest.scope).collections = collections;
                    }
                } catch (e) {
                    console.warn(`Could not read verify data for ${backupId}:`, /** @type {Error} */ (e).message);
                }
            } else {
                let errDetail = '';
                try {
                    const log = (await readFile(join(dir, 'runner.log'), 'utf8')).trim();
                    errDetail = log.split('\n').slice(-20).join('\n');
                } catch { /* no runner.log */ }
                manifest.error = errDetail || `Runner exited with code ${code}`;
            }

            await writeManifest(dir, manifest);
            await releaseLock(LIVE_DB);
            console.log(`Lock released: ${backupId}`);

            appendActivity({
                action: code === 0 ? 'backup_success' : 'backup_failed',
                backupId,
                source,
                detail: code === 0 ? undefined : String(manifest.error)
            }).catch(() => {});

            if (source === 'scheduled') {
                if (code === 0) {
                    try {
                        await enforceRetention();
                    } catch (e) {
                        console.warn('Retention enforcement failed:', /** @type {Error} */ (e).message);
                    }
                } else {
                    notifyAdmins(
                        `Scheduled backup failed: ${backupId}`,
                        String(manifest.error || `Runner exited with code ${code}`)
                    ).catch(() => {});
                }
            }
        })
        .catch(async err => {
            console.error(`Monitor error for ${backupId}:`, err.message);
            // Reaching this point means the terminal manifest write (or some
            // other unguarded step) failed, so the on-disk manifest may still
            // say "running". Best-effort: re-read it and mark it failed, then
            // release the lock. Only release the lock once the manifest is
            // confirmed terminal: if persisting the failed status keeps failing
            // (e.g. ENOSPC/EROFS), the LIVE_DB lock is deliberately left in
            // place as a recovery anchor so startup recovery can finish the job.
            // Without this anchor, a stuck "running" manifest would have no lock
            // for recoverStaleLocks() to act on.
            try {
                const m = /** @type {Manifest|null} */ (await readManifest(dir));
                if (m && m.status === 'running') {
                    m.status = 'failed';
                    m.error = `Backup monitor failed to persist result: ${err.message}`;
                    m.finishedAt = new Date().toISOString();
                    await writeManifest(dir, m);
                }
                await releaseLock(LIVE_DB);
                console.log(`Lock released after monitor error: ${backupId}`);
            } catch (e2) {
                console.error(`Could not finalize manifest after monitor error for ${backupId} — keeping LIVE_DB lock as recovery anchor:`, /** @type {Error} */ (e2).message);
            }
        });
}

// ── Backup ────────────────────────────────────────────────────

/**
 * Validates quota, acquires the lock, spawns run.sh as a child process,
 * and delegates post-exit handling to {@link monitorProcess}.
 * @param   {string}                                                                                                                     backupId         Pre-generated backup ID.
 * @param   {string}                                                                                                                     source           `'manual'` or `'scheduled'`.
 * @param   {{ database: boolean, assets: boolean, extensions: boolean, includeCollections?: string[], excludedCollections?: string[] }} [scopeOverride]  Per-run scope (manual backups, allowlist); falls back to the configured `backupScope` (blocklist).
 * @returns {Promise<{ ok: true, status: 202, backupId: string } | { ok: false, status: number, error: string }>}                                         Acceptance result, or an error with HTTP status.
 */
export async function startBackup(backupId, source, scopeOverride) {
    const backupPath = resolvePath(BACKUP_DIR, backupId);

    let quota = await checkQuota();
    if (!quota.ok) {
        if (source === 'scheduled') {
            console.warn(`Quota exceeded before scheduled backup, rotating: ${quota.reasons.map(r => r.text).join('; ')}`);
            const freed = await rotateForSpace();
            if (freed) quota = await checkQuota();
        }
        if (!quota.ok) {
            const first = quota.reasons[0];
            const msg = quota.reasons.map(r => r.text).join('; ');
            console.warn(`Skipping backup (quota): ${msg}`);
            appendActivity({ action: 'backup_failed', backupId, source, detail: `Quota: ${msg}` }).catch(() => {});
            if (source === 'scheduled') {
                notifyAdmins('Scheduled backup skipped: storage limit reached', msg).catch(() => {});
            }
            return { ...first, ok: false, status: 507, error: msg };
        }
    }

    const now = new Date().toISOString();
    const label = backupId.split('__')[2] || 'manual';

    const locked = await acquireLock(LIVE_DB, { backupId, startedAt: now, source, operation: 'backup' });
    if (!locked) {
        console.warn(`Skipping backup (locked): ${backupId}`);
        appendActivity({ action: 'backup_failed', backupId, source, detail: 'Another backup or restore is already running' }).catch(() => {});
        return { ok: false, status: 409, error: 'Another backup or restore is already running' };
    }

    const [directusVersion, cfg] = await Promise.all([fetchDirectusVersion(), readConfig()]);
    const scope = scopeOverride || cfg.backupScope;
    const scopeEnv = buildScopeEnv('backup', scope);

    const includedCollections = /** @type {{ includeCollections?: string[] }} */ (scope).includeCollections || [];

    /** @type {Manifest} */
    const manifest = {
        id: backupId,
        createdAt: now,
        label,
        source,
        status: 'running',
        dumpFormat: BACKUP_DUMP_FORMAT,
        tool: { name: DB_ADAPTER },
        scope: {
            database: scope.database,
            assets: scope.assets,
            extensions: scope.extensions,
            // Record the effective inclusion list in the manifest for historical display.
            // For blocklist-based global scope (excludedCollections), the actual included
            // tables are determined at dump time; we record the exclusions instead.
            ...scope.excludedCollections && scope.excludedCollections.length > 0
                ? { excludedCollections: [...scope.excludedCollections] }
                : { includedCollections: [...includedCollections] }
        },
        ...directusVersion && { directusVersion }
    };
    const logPath = join(backupPath, 'runner.log');
    let runnerPromise;
    try {
        // The initial manifest write is inside the try so that a failure here
        // (e.g. EACCES/ENOSPC/EROFS on BACKUP_DIR) releases the LIVE_DB lock too,
        // instead of leaking it and blocking all future backups/restores.
        await writeManifest(backupPath, manifest);
        const env = buildRunnerEnv('backup', backupId, backupPath, BACKUP_DUMP_FORMAT, scopeEnv);
        runnerPromise = spawnRunner(env, logPath);
    } catch (e) {
        const errMsg = /** @type {Error} */ (e).message || String(e);
        console.error('Failed to start backup:', errMsg);
        manifest.status = 'failed';
        manifest.error = `Failed to start backup: ${errMsg}`;
        manifest.finishedAt = new Date().toISOString();
        // Best-effort: if the failure was the manifest write itself, this will
        // throw again. Releasing the lock is the critical step, so it must run
        // regardless of whether the status update can be persisted.
        try {
            await writeManifest(backupPath, manifest);
        } catch (writeErr) {
            console.error('Could not persist failed-status manifest:', /** @type {Error} */ (writeErr).message);
        }
        await releaseLock(LIVE_DB);
        appendActivity({ action: 'backup_failed', backupId, source, detail: String(manifest.error) }).catch(() => {});
        if (source === 'scheduled') {
            notifyAdmins(`Scheduled backup failed: ${backupId}`, String(manifest.error)).catch(() => {});
        }
        return { ok: false, status: 503, error: `Failed to start backup: ${errMsg}` };
    }

    monitorProcess(runnerPromise, backupId, source);

    return { ok: true, status: 202, backupId };
}

// ── Restore ───────────────────────────────────────────────────

/**
 * Resolves the effective restore scope from the backup manifest and the per-run request scope,
 * clamping to what is actually present in the backup.
 *
 * Include-list intersection rules:
 * - Both empty  → restore all (no collection filter).
 * - Backup only → restore exactly what the backup included.
 * - Request only → restore the requested subset (backup had everything).
 * - Both set    → restore the intersection (can't restore what wasn't backed up).
 * @param   {Manifest}                                                                                                                        manifest        The backup manifest.
 * @param   {{ database: boolean, assets: boolean, extensions: boolean, includeCollections: string[] }}                                       [requestScope]  Per-run scope; defaults to restoring everything present in the backup.
 * @returns {{ restoreScope: { database: boolean, assets: boolean, extensions: boolean, includeCollections: string[] }, scopeEnv: string[] }}                 Resolved scope object and shell env vars for run.sh.
 */
function resolveRestoreScope(manifest, requestScope) {
    const scope = manifest.scope || {};
    const base = requestScope || {
        database: scope.database !== false,
        assets: scope.assets !== false,
        extensions: scope.extensions !== false,
        includeCollections: []
    };
    const backupIncluded = Array.isArray(scope.includedCollections) ? scope.includedCollections : [];
    const requestIncluded = base.includeCollections || [];

    /** @type {string[]} */
    let effectiveInclude;
    if (backupIncluded.length === 0 && requestIncluded.length === 0) {
        effectiveInclude = [];
    } else if (backupIncluded.length === 0) {
        effectiveInclude = requestIncluded;
    } else if (requestIncluded.length === 0) {
        effectiveInclude = backupIncluded;
    } else {
        const backupSet = new Set(backupIncluded);
        effectiveInclude = requestIncluded.filter(c => backupSet.has(c));
    }

    const restoreScope = {
        database: Boolean(base.database) && scope.database !== false,
        assets: Boolean(base.assets) && scope.assets !== false,
        extensions: Boolean(base.extensions) && scope.extensions !== false,
        includeCollections: effectiveInclude
    };
    return { restoreScope, scopeEnv: buildScopeEnv('restore', restoreScope) };
}

/**
 * Executes the full restore sequence asynchronously:
 * 1. Stops the Directus container.
 * 2. Spawns run.sh in restore mode (verifies checksums, restores the database
 * via the configured DB adapter, unpacks uploads + extensions, writes
 * post-restore counts).
 * 3. Flushes the Redis cache.
 * 4. Starts the Directus container.
 * 5. Updates the manifest with `restoreStatus`, `restoreVerify`, and
 * `restoreError` (on failure), then releases the lock.
 * @param {string}                                                                                    backupId        Backup ID to restore.
 * @param {Manifest}                                                                                  manifest        The manifest as read before the restore started.
 * @param {string}                                                                                    backupPath      Absolute path to the backup directory.
 * @param {{ database: boolean, assets: boolean, extensions: boolean, includeCollections: string[] }} [requestScope]  Per-run restore scope; defaults to restoring everything present in the backup.
 */
export async function doRestore(backupId, manifest, backupPath, requestScope) {
    const dumpFormat = String(manifest.dumpFormat || 'custom');
    const { scopeEnv } = resolveRestoreScope(manifest, requestScope);

    // Directus must be stopped before the database is touched. If we cannot
    // guarantee it is stopped, abort before any destructive action so the live
    // system is left untouched. An already-stopped container is fine (e.g.
    // disaster recovery) and proceeds normally.
    try {
        const dc = await findDirectusContainer();
        const dcInfo = await dc.inspect();
        ctx.directusContainerId = dcInfo.Id;
        if (dcInfo.State?.Running) {
            console.log(`Restore: stopping Directus (${dcInfo.Name})`);
            await dc.stop({ t: 10 });
        } else {
            console.log(`Restore: Directus already stopped (${dcInfo.Name})`);
        }
    } catch (e) {
        const msg = /** @type {Error} */ (e).message;
        console.error('Restore aborted: could not stop Directus:', msg);
        manifest.restoredAt = new Date().toISOString();
        manifest.restoreStatus = 'failed';
        manifest.restoreError = `Aborted before restore: could not stop Directus (${msg}). The database was not modified.`;
        await writeManifest(backupPath, manifest);
        appendActivity({ action: 'restore_failed', backupId, detail: String(manifest.restoreError) }).catch(() => {});
        await releaseLock(backupId);
        await releaseLock(LIVE_DB);
        console.log(`Restore aborted (Directus not stopped): ${backupId}`);
        return;
    }

    const logPath = join(backupPath, 'runner.log');
    let exitCode = 1;
    let timedOut = false;
    try {
        const env = buildRunnerEnv('restore', backupId, backupPath, dumpFormat, scopeEnv);
        const result = await spawnRunner(env, logPath);
        ({ exitCode, timedOut } = result);
        console.log(`Restore runner exited: ${backupId} code=${exitCode}${timedOut ? ' (timed out)' : ''}`);
    } catch (e) {
        console.error(`Restore runner failed for ${backupId}:`, /** @type {Error} */ (e).message);
    }

    try {
        await flushCache();
    } catch (e) {
        console.warn('Restore: cache flush failed (non-fatal):', /** @type {Error} */ (e).message);
    }

    if (ctx.directusContainerId) {
        try {
            console.log('Restore: starting Directus');
            await docker.getContainer(ctx.directusContainerId).start();
        } catch (e) {
            console.warn('Restore: could not start Directus:', /** @type {Error} */ (e).message);
        }
    } else {
        console.warn('Restore: no Directus container ID — cannot restart');
    }

    manifest.restoredAt = new Date().toISOString();

    if (exitCode === 0) {
        const restoreResult = await parseRestoreResult(backupPath);
        if (restoreResult) manifest.restore = restoreResult;
        manifest.restoreStatus = 'success';
        try {
            manifest.restoreVerify = await parseRestoreVerify(backupPath);
        } catch {
            // restore-verify.txt absent for backups predating the verify feature
        }
    } else {
        manifest.restoreStatus = 'failed';
        let errMsg = '';
        if (timedOut) {
            errMsg = 'Restore aborted: runner exceeded the configured timeout '
              + '(RUNNER_TIMEOUT_MIN) and was terminated. The database may be '
              + 'left in a partially restored state — see runner.log and the '
              + 'manual recovery steps in the docs.';
        }
        try {
            if (!errMsg) errMsg = (await readFile(join(backupPath, 'restore-error.txt'), 'utf8')).trim();
        } catch { /* no restore-error.txt */ }
        if (!errMsg) {
            try {
                const log = (await readFile(logPath, 'utf8')).trim();
                const lines = log.split('\n').slice(-20);
                errMsg = lines.join('\n') || `Exit code ${exitCode}`;
            } catch { /* no runner.log either */ }
        }
        manifest.restoreError = errMsg || `Runner exited with code ${exitCode}`;
    }
    await writeManifest(backupPath, manifest);

    /** @type {'restore_success'|'restore_failed'} */
    let restoreAction = 'restore_success';
    /** @type {string|undefined} */
    let restoreDetail;
    if (manifest.restoreStatus === 'failed') {
        restoreAction = 'restore_failed';
        restoreDetail = String(manifest.restoreError);
    }
    appendActivity({ action: restoreAction, backupId, detail: restoreDetail }).catch(() => {});

    if (exitCode === 0) {
        await triggerPostRestoreHook(backupId);
    }

    await releaseLock(backupId);
    await releaseLock(LIVE_DB);
    console.log(`Restore complete: ${backupId} status=${manifest.restoreStatus}`);
}

// ── Stale lock recovery ───────────────────────────────────────

/**
 * Recovers a single stale lock found at startup, mutating the affected
 * manifest where appropriate. Each lock file is processed independently and
 * idempotently. Manifest state for an interrupted restore is recorded under
 * the `LIVE_DB` lock only, so the matching per-backup restore lock is a no-op.
 * @param {Record<string, unknown>} lock  Parsed lock contents (`resource` plus metadata).
 */
async function recoverStaleLock(lock) {
    const resource = String(lock.resource);
    const { operation } = lock;

    if (resource === LIVE_DB) {
        // backup or restore touched the live system and was interrupted.
        const backupId = lock.backupId ? String(lock.backupId) : null;
        if (!backupId || !BACKUP_ID_RE.test(backupId)) return;
        const dir = join(BACKUP_DIR, backupId);
        const m = await readManifest(dir);
        if (!m) return;
        if (operation === 'restore') {
            // The backup's own `status` stays as-is; the interrupted restore is
            // recorded through the restore fields. The outcome is unknown — the
            // database may have been partially restored before the crash.
            m.restoredAt = m.restoredAt || new Date().toISOString();
            m.restoreStatus = 'failed';
            m.restoreError = 'Sidecar restarted during restore — outcome unknown; the database may be partially restored. Re-run the restore.';
            await writeManifest(dir, m);
            appendActivity({ action: 'restore_failed', backupId, detail: String(m.restoreError) }).catch(() => {});
        } else if (m.status === 'running') {
            m.status = 'failed';
            m.error = 'Stale lock recovered on startup';
            m.finishedAt = new Date().toISOString();
            await writeManifest(dir, m);
        }
        return;
    }

    // Per-backup-directory lock (restore source, download, or delete).
    if (!BACKUP_ID_RE.test(resource)) return;
    if (operation === 'delete') {
        // A delete was interrupted mid-removal. Finish it so no half-deleted
        // backup directory is left behind. The manifest is not consulted because
        // it may already have been (partially) removed.
        const dir = join(BACKUP_DIR, resource);
        try {
            await rm(dir, { recursive: true, force: true });
            console.log(`Completed interrupted delete: ${resource}`);
        } catch (e) {
            console.warn(`Could not complete interrupted delete for ${resource}:`, /** @type {Error} */ (e).message);
        }
        appendActivity({ action: 'delete', backupId: resource, detail: 'Completed after sidecar restart during delete' }).catch(() => {});
    }
    // 'download', 'import', and the per-backup side of 'restore' need no
    // manifest recovery here; the lock is simply released by the caller. A
    // crashed import may leave a partial directory — it is intentionally not
    // auto-removed (the crash could have happened over a pre-existing backup);
    // the operator can delete a stray partial via the normal delete path.
}

/**
 * Called once at startup. A backup/restore/download/delete/import runs as a
 * child of this process (or in-process) and cannot survive a container restart,
 * so every lock found at startup is stale by definition. Each lock is recovered
 * and then removed.
 *
 * The two lock domains are recovered independently: the global `LIVE_DB` lock
 * carries the backup/restore manifest recovery, while per-backup-ID locks carry
 * delete completion. See {@link recoverStaleLock} for per-resource handling.
 */
export async function recoverStaleLocks() {
    const locks = await readAllLocks();
    if (locks.length === 0) return;

    console.log(`Found ${locks.length} stale lock(s) on startup — cleaning up`);
    for (const lock of locks) {
        try {
            await recoverStaleLock(lock);
        } catch (e) {
            console.warn(`Lock recovery failed for ${lock.resource}:`, /** @type {Error} */ (e).message);
        }
        await releaseLock(String(lock.resource));
    }
    console.log('Stale locks removed');
}

/**
 * Marks any manifest still in `status: "running"` as failed. Called once at
 * startup, after {@link recoverStaleLocks}. A backup runs as a child of this
 * process and cannot survive a container restart, so a `running` status found
 * at startup is always stale.
 *
 * This is the safety net for the case where {@link monitorProcess} could not
 * persist the terminal manifest and its `LIVE_DB` lock was already released —
 * leaving a backup stuck as `running` with no lock for {@link recoverStaleLocks}
 * to act on. Lock-based recovery runs first, so its more specific status is kept
 * when present; this pass only touches manifests still left at `running`.
 */
export async function reconcileRunningManifests() {
    const manifests = await readAllManifests();
    for (const m of manifests) {
        if (m.status !== 'running') continue;
        const id = String(m.id);
        if (!BACKUP_ID_RE.test(id)) continue;
        m.status = 'failed';
        m.error = m.error || 'Backup left running after sidecar restart — outcome unknown';
        m.finishedAt = m.finishedAt || new Date().toISOString();
        try {
            await writeManifest(join(BACKUP_DIR, id), m);
            console.log(`Reconciled stale running manifest: ${id}`);
        } catch (e) {
            console.warn(`Could not reconcile running manifest ${id}:`, /** @type {Error} */ (e).message);
        }
    }
}
