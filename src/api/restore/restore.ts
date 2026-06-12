/**
 * Restore arming (Directus still up) and the container-restart handoff.
 *
 * Restores cannot run while Directus holds database connections, so the
 * destructive work is moved out of this process entirely (no Docker socket):
 * 1. {@link requestRestore} Validates the backup while Directus is still up,
 * writes a `KEY=VALUE` flag file, and acquires the locks.
 * 2. {@link scheduleContainerRestart} Sends `SIGTERM` to PID 1 (pm2-runtime),
 * which — together with the container's `restart: unless-stopped` policy —
 * restarts the container. `restore.sh` then runs the actual restore on the
 * fresh, idle boot, before Directus starts, and leaves a result marker.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { readFile, rename, access, open as fsOpen, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { config, LIVE_DB, restoreFlagPath } from '../core/config.js';
import { notifyAdmins } from '../core/notify.js';
import { getRuntime } from '../core/runtime.js';
import { appendActivity } from '../core/activity.js';
import { acquireLock, releaseLock } from '../storage/locks.js';
import { type Manifest } from '../storage/manifest.js';
import { buildScopeEnv, type ActionResult } from '../backup/process.js';
import { getSanityReport, installationError } from '../core/sanity.js';
import type { RunScope } from '../../shared/types.js';

// ── Restore: scope resolution ─────────────────────────────────

/**
 * Resolves the effective restore scope from the backup manifest and the per-run
 * request scope, clamping to what is actually present in the backup.
 * @param manifest      The backup manifest.
 * @param requestScope  Per-run scope; defaults to restoring everything present in the backup.
 * @returns             Resolved scope object and shell env vars for `restore.sh`.
 */
function resolveRestoreScope(manifest: Manifest, requestScope?: RunScope): { restoreScope: RunScope, scopeEnv: string[] } {
    const scope = (manifest.scope || {}) as { database?: boolean, assets?: boolean, extensions?: boolean, includedCollections?: string[] };
    const base = requestScope || {
        database: scope.database !== false,
        assets: scope.assets !== false,
        extensions: scope.extensions !== false,
        includeCollections: []
    };
    const backupIncluded = Array.isArray(scope.includedCollections) ? scope.includedCollections : [];
    const requestIncluded = base.includeCollections || [];

    let effectiveInclude: string[];
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

    const restoreScope: RunScope = {
        database: Boolean(base.database) && scope.database !== false,
        assets: Boolean(base.assets) && scope.assets !== false,
        extensions: Boolean(base.extensions) && scope.extensions !== false,
        includeCollections: effectiveInclude
    };
    return { restoreScope, scopeEnv: buildScopeEnv('restore', restoreScope) };
}

// ── Restore: pre-validation (Directus still up) ───────────────

/** Computes the SHA-256 of a file as a lowercase hex string. */
function sha256File(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(path);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/** Runs `pg_restore --list` on a custom-format dump; resolves to its exit code. */
function pgRestoreListExit(dumpPath: string): Promise<number> {
    return new Promise(resolve => {
        execFile('pg_restore', ['--list', dumpPath], err => {
            const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
            resolve(code);
        });
    });
}

/**
 * Validates a restore while Directus is still running, BEFORE the destructive
 * `DROP SCHEMA` (point of no return) can ever run. Any failure here aborts the
 * restore with the database untouched and no container restart.
 *
 * Checks (only the DB-relevant ones when the database is in scope):
 * 1. Manifest `status === 'success'` (the backup itself completed).
 * 2. Checksums match `checksums.sha256` (guards against on-disk corruption).
 * 3. `pg_restore --list` exits 0 for the dump (guards against an
 * unreadable/truncated dump — the gap that caused silent data loss in the POC).
 * 4. The database is reachable (`SELECT 1`).
 * @param manifest      The backup manifest.
 * @param backupPath    Absolute path to the backup directory.
 * @param restoreScope  Resolved restore scope.
 * @returns             `{ ok: true }` or `{ ok: false, error }`.
 */
async function validateRestore(manifest: Manifest, backupPath: string, restoreScope: RunScope): Promise<{ ok: true } | { ok: false, error: string }> {
    if (manifest.status !== 'success') {
        return { ok: false, error: `Backup status is "${String(manifest.status)}", not "success" — refusing to restore` };
    }

    // Checksum verification (all components present in the backup).
    try {
        const checksumRaw = await readFile(join(backupPath, 'checksums.sha256'), 'utf8');
        for (const line of checksumRaw.trim().split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 2) continue;
            const expected = parts[0];
            const file = parts[parts.length - 1];
            let actual: string;
            try {
                actual = await sha256File(join(backupPath, file));
            } catch {
                return { ok: false, error: `Backup file missing or unreadable: ${file}` };
            }
            if (actual !== expected) {
                return { ok: false, error: `Checksum mismatch for ${file} — backup is corrupt` };
            }
        }
    } catch {
        // No checksums.sha256 (legacy backup): cannot verify, fall through to the
        // dump-readability check, which is the critical guard against data loss.
        getRuntime().logger?.warn?.('Restore validation: no checksums.sha256 — skipping checksum verify (legacy backup)');
    }

    if (restoreScope.database) {
        const dumpPath = join(backupPath, 'database.dump');
        try {
            await access(dumpPath);
        } catch {
            return { ok: false, error: 'Database restore requested but database.dump is missing' };
        }
        const listExit = await pgRestoreListExit(dumpPath);
        if (listExit !== 0) {
            return { ok: false, error: `Dump is not readable by pg_restore (exit ${listExit}) — refusing to restore` };
        }

        try {
            await getRuntime().database.raw('select 1');
        } catch (e) {
            return { ok: false, error: `Database not reachable: ${(e as Error).message}` };
        }
    }

    return { ok: true };
}

// ── Restore: request (write flag, then restart) ───────────────

/**
 * Quotes a value for safe inclusion in the sh-sourced flag file. The flag file
 * is read back with `. "$file"`, so an unquoted value containing a newline or
 * `$(…)` would be executed as shell. Single-quoting (with the standard
 * `'\''` escape for embedded single quotes) makes every value an inert literal.
 */
function shQuote(value: string): string {
    return `'${value.replace(/'/g, '\'\\\'\'')}'`;
}

/** Serialises a runner env map to the sh-friendly `KEY=VALUE` flag format. */
function toFlagContent(vars: Record<string, string>): string {
    return `${Object.entries(vars).map(([k, v]) => `${k}=${shQuote(v)}`).join('\n')}\n`;
}

/** Atomically writes the restore flag (temp file + fsync + rename). */
async function writeFlagAtomically(content: string): Promise<void> {
    const target = restoreFlagPath();
    const tmp = `${target}.tmp`;
    const fd = await fsOpen(tmp, 'w');
    try {
        await fd.writeFile(content, 'utf8');
        await fd.sync();
    } finally {
        await fd.close();
    }
    await rename(tmp, target);
}

/**
 * Validates and arms a restore. On success the caller MUST respond to the
 * client and then call {@link scheduleContainerRestart}; the actual restore runs
 * on the next boot via `restore.sh`.
 *
 * Locks are acquired here (LIVE_DB then the per-backup ID) and released later by
 * `finalizePendingRestore` after the restart, mirroring the cross-restart
 * recovery the sidecar already performs for stale locks.
 * @param backupId      Backup ID to restore.
 * @param manifest      Manifest read before the restore.
 * @param backupPath    Absolute path to the backup directory.
 * @param requestScope  Per-run restore scope; defaults to everything present.
 * @returns             Acceptance result, or an error with HTTP status.
 */
export async function requestRestore(backupId: string, manifest: Manifest, backupPath: string, requestScope?: RunScope): Promise<ActionResult> {
    // resolveRestoreScope is pure (no I/O) — run it first so the collections
    // check below can use the fully-resolved scope before any blocking I/O.
    const { restoreScope, scopeEnv } = resolveRestoreScope(manifest, requestScope);

    // Validate requested collections against the dump's positive index (scope.collections).
    // Runs before getSanityReport() so clearly invalid requests fail fast without I/O.
    // Only relevant for targeted DB restores; skip when no collections are requested or
    // the positive index is absent (legacy backup without scope.collections).
    if (restoreScope.database && restoreScope.includeCollections.length > 0) {
        const scopeData = (manifest.scope || {}) as { collections?: unknown };
        const dumpCollections = Array.isArray(scopeData.collections) ? scopeData.collections as string[] : null;
        if (dumpCollections !== null) {
            const dumpSet = new Set(dumpCollections);
            const unknown = restoreScope.includeCollections.filter(c => !dumpSet.has(c));
            if (unknown.length > 0) {
                const error = `Collections not present in backup dump: ${unknown.join(', ')}`;
                appendActivity({ action: 'restore_failed', backupId, detail: error }).catch(() => {});
                return { ok: false, status: 422, error };
            }
        }
    }

    const sanity = await getSanityReport();
    if (!sanity.restoreReady) {
        return {
            ok: false,
            status: 503,
            error: installationError(sanity),
            code: 'INSTALL_INCOMPLETE'
        };
    }

    const validation = await validateRestore(manifest, backupPath, restoreScope);
    if (!validation.ok) {
        appendActivity({ action: 'restore_failed', backupId, detail: validation.error }).catch(() => {});
        return { ok: false, status: 422, error: validation.error };
    }

    const now = new Date().toISOString();
    const liveLocked = await acquireLock(LIVE_DB, { backupId, startedAt: now, operation: 'restore' });
    if (!liveLocked) {
        return { ok: false, status: 409, error: 'Another backup or restore is already running' };
    }
    const idLocked = await acquireLock(backupId, { backupId, startedAt: now, operation: 'restore' });
    if (!idLocked) {
        await releaseLock(LIVE_DB);
        return { ok: false, status: 409, error: 'This backup is busy (download or delete in progress)' };
    }

    const flagVars: Record<string, string> = {
        BACKUP_ID: backupId,
        BACKUP_PATH: backupPath,
        DB_ADAPTER: config.dbAdapter,
        UPLOADS_DIR: config.uploadsDir,
        EXTENSIONS_DIR: config.extensionsDir
    };
    for (const entry of scopeEnv) {
        const eq = entry.indexOf('=');
        if (eq > 0) flagVars[entry.slice(0, eq)] = entry.slice(eq + 1);
    }

    try {
        await writeFlagAtomically(toFlagContent(flagVars));
    } catch (e) {
        await releaseLock(backupId);
        await releaseLock(LIVE_DB);
        const error = `Could not arm restore: ${(e as Error).message}`;
        appendActivity({ action: 'restore_failed', backupId, detail: error }).catch(() => {});
        return { ok: false, status: 503, error };
    }

    return { ok: true, status: 202, backupId };
}

/**
 * Sends SIGTERM to PID 1 (pm2-runtime) after a short delay so the HTTP response
 * has flushed. The container's `restart: unless-stopped` policy then restarts
 * it, and `restore.sh` performs the restore before Directus boots.
 *
 * If the signal cannot be delivered (e.g. EPERM), the process will not restart
 * and `finalizePendingRestore` will never run — locks and flag would remain
 * permanently. On kill failure we therefore roll back: release both locks,
 * delete the flag, and record the failure in the activity log.
 * @param backupId  The backup ID being restored (needed for lock rollback).
 * @param delayMs   Delay before signalling, to let the response flush.
 */
export function scheduleContainerRestart(backupId: string, delayMs = 1000): void {
    getRuntime().logger?.info?.('Restore armed — scheduling container restart (SIGTERM to PID 1)');
    setTimeout(async() => {
        try {
            process.kill(1, 'SIGTERM');
        } catch (e) {
            const msg = `Could not signal PID 1 for restart: ${(e as Error).message}`;
            getRuntime().logger?.error?.(msg);
            // Roll back: the container will not restart so finalizePendingRestore
            // will never clean up. Release locks and flag now, then record the failure.
            try { await unlink(restoreFlagPath()); } catch { /* already gone */ }
            await releaseLock(backupId).catch(() => {});
            await releaseLock(LIVE_DB).catch(() => {});
            appendActivity({ action: 'restore_failed', backupId, detail: msg }).catch(() => {});
        }
    }, delayMs);
}

// ── Restore: post-restore hook ────────────────────────────────

/**
 * Polls the local Directus health endpoint until it responds with HTTP 200 or
 * the timeout expires. Necessary because `finalizePendingRestore` runs early
 * in the extension init — before the HTTP server has finished binding — so a
 * hook fired immediately would reach the sync service before Directus is ready
 * to accept inbound requests (causing ECONNREFUSED on the callback).
 * @param logger  Directus logger (optional, best-effort).
 */
async function waitForDirectusReady(logger: any): Promise<void> {
    const port = process.env.PORT ?? '8055';
    const healthUrl = `http://localhost:${port}/server/health`;
    const deadlineMs = 3 * 60 * 1000; // 3 min max
    const intervalMs = 3_000;
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
            if (res.ok) {
                logger?.info?.('Directus ready — firing post-restore hook');
                return;
            }
        } catch { /* not ready yet */ }
        await new Promise<void>(resolve => { setTimeout(resolve, intervalMs); });
    }
    logger?.warn?.('Directus health check timed out after 3 min — firing post-restore hook anyway');
}

/**
 * Fires the post-restore webhook if configured. Waits for Directus to be
 * healthy first so that the receiving service can safely connect back.
 * @param backupId  Backup ID, for logging and notifications.
 */
export async function triggerPostRestoreHook(backupId: string): Promise<void> {
    const { url, secret, hint } = config.hooks.postRestore;
    if (!url) return;

    await waitForDirectusReady(getRuntime().logger);

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
        const response = await fetch(url, {
            method: 'POST',
            headers: { ...secret && { 'X-Webhook-Secret': secret } },
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`Hook returned ${response.status}: ${errorText}`);
        }
        getRuntime().logger?.info?.('Post-restore hook completed successfully');
    } catch (error) {
        const err = error as Error;
        const errorMsg = err.name === 'AbortError' ? 'Post-restore hook timed out after 5 minutes' : err.message;
        getRuntime().logger?.error?.(`Post-restore hook failed: ${errorMsg}`);
        const hintText = hint ? `\n\nRecovery: ${hint}` : '';
        notifyAdmins(
            'Restore completed but post-restore hook failed',
            `Backup ${backupId} was restored successfully, but the post-restore hook failed.\n\nError: ${errorMsg}${hintText}`
        ).catch(() => {});
    }
}
