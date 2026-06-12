/**
 * Runner process plumbing shared by backups and restores: script resolution,
 * environment/scope construction, the detached child-process spawner with its
 * timeout watchdog, and the cancellation registry.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { readdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { config } from '../core/config.js';

/** Result of a backup/restore acceptance attempt, mirroring the sidecar's HTTP shape. */
export type ActionResult
    = | { ok: true, status: number, backupId: string }
      | { ok: false, status: number, error: string, code?: string };

// ── Runner script resolution ──────────────────────────────────

let cachedScriptDir: string | null = null;

/**
 * Locates the directory holding the bundled runner scripts. Searches the
 * extensions directory for an installed copy of this package (marketplace
 * installs live under `.registry/<id>/`, local installs directly under
 * `<extensionsDir>/`). The result is cached after the first successful lookup.
 * @returns Absolute path to the `scripts` directory containing `backup.sh`.
 * @throws If `backup.sh` cannot be found in any candidate location.
 */
export async function resolveScriptsDir(): Promise<string> {
    if (cachedScriptDir) return cachedScriptDir;

    const roots = [join(config.extensionsDir, '.registry'), config.extensionsDir];
    for (const root of roots) {
        let entries: string[];
        try {
            entries = await readdir(root);
        } catch {
            continue;
        }

        for (const entry of entries) {
            const candidate = join(root, entry, 'scripts');
            try {
                await access(join(candidate, 'backup.sh'));
                cachedScriptDir = candidate;
                return candidate;
            } catch {
                // not here — keep looking
            }
        }
    }
    throw new Error(`backup.sh not found under ${config.extensionsDir} (searched .registry/*/scripts and */scripts)`);
}

// ── Cancellation registry ─────────────────────────────────────

/**
 * Maps a running backup ID to a function that sends SIGTERM to its process
 * group. Populated by {@link spawnRunner} after spawn and cleared on child
 * close. Only backup runs register here (restore runs do not spawn a child).
 */
const activeKillFns = new Map<string, () => void>();

/** Backup IDs for which {@link cancelBackup} was called while still running. */
export const cancelledIds = new Set<string>();

/**
 * Signals the process group of a running backup to terminate gracefully.
 * @param backupId  The backup ID to cancel.
 * @returns         `true` if a running process was found and signalled.
 */
export function cancelBackup(backupId: string): boolean {
    const kill = activeKillFns.get(backupId);
    if (!kill) return false;
    cancelledIds.add(backupId);
    kill();
    return true;
}

// ── Runner helpers ────────────────────────────────────────────

/**
 * Builds the environment variables passed to the `backup.sh` child process.
 * @param backupId    Timestamped ID of the backup directory.
 * @param backupPath  Absolute path to the backup directory.
 * @param scopeEnv    Extra scope env vars (e.g. `BACKUP_INCLUDE_DB=1`).
 * @returns           Environment variables for the `backup.sh` child process.
 */
export function buildRunnerEnv(backupId: string, backupPath: string, scopeEnv: string[]): Record<string, string> {
    const env: Record<string, string> = {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        BACKUP_ID: backupId,
        BACKUP_PATH: backupPath,
        DB_ADAPTER: config.dbAdapter,
        DB_HOST: config.db.host,
        DB_PORT: String(config.db.port),
        DB_USER: config.db.user,
        DB_PASSWORD: config.db.password,
        DB_DATABASE: config.db.database,
        UPLOADS_DIR: config.uploadsDir,
        EXTENSIONS_DIR: config.extensionsDir
    };

    for (const entry of scopeEnv) {
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
 * @param mode                       Runner mode; selects the `BACKUP_`/`RESTORE_` env prefix.
 * @param scope                      Scope config to convert.
 * @param scope.database             Include the database dump.
 * @param scope.assets               Include uploaded assets.
 * @param scope.extensions           Include installed extensions.
 * @param scope.includeCollections   Allowlist of collections (per-run scope).
 * @param scope.excludedCollections  Blocklist of collections (global config scope).
 * @returns                          Scope env-var strings for the runner.
 */
export function buildScopeEnv(mode: 'backup' | 'restore', scope: { database: boolean, assets: boolean, extensions: boolean, includeCollections?: string[], excludedCollections?: string[] }): string[] {
    const prefix = mode === 'backup' ? 'BACKUP' : 'RESTORE';
    const envs = [
        `${prefix}_INCLUDE_DB=${scope.database ? '1' : '0'}`,
        `${prefix}_INCLUDE_ASSETS=${scope.assets ? '1' : '0'}`,
        `${prefix}_INCLUDE_EXTENSIONS=${scope.extensions ? '1' : '0'}`
    ];

    if (scope.excludedCollections && scope.excludedCollections.length > 0) {
        envs.push(`${prefix}_EXCLUDE_TABLES=${scope.excludedCollections.join(',')}`);
        envs.push(`${prefix}_INCLUDE_TABLES=`);
    } else {
        envs.push(`${prefix}_INCLUDE_TABLES=${(scope.includeCollections || []).join(',')}`);
        envs.push(`${prefix}_EXCLUDE_TABLES=`);
    }

    return envs;
}

/**
 * Spawns `backup.sh` as a detached process-group leader and pipes stdout+stderr
 * to a log file. On timeout the whole group receives SIGTERM, escalated to SIGKILL
 * after a grace period, so a child blocked on a lock wait cannot be orphaned.
 * @param env             Environment variables for the child process.
 * @param logPath         Absolute path to the log file.
 * @param opts            Overrides for the spawn.
 * @param opts.timeoutMs  Runner timeout in ms (defaults to the configured value).
 * @param opts.command    Command to spawn.
 * @param opts.args       Command arguments.
 * @returns               Exit code and whether the timeout fired.
 */
export function spawnRunner(
    env: Record<string, string>,
    logPath: string,
    { timeoutMs = config.runnerTimeoutMs, command, args = [] }: { timeoutMs?: number, command: string, args?: string[] }
): Promise<{ exitCode: number, timedOut: boolean }> {
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
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        let escalateTimer: ReturnType<typeof setTimeout> | null = null;

        const killGroup = (signal: NodeJS.Signals): void => {
            if (child.pid === undefined) return;
            try {
                process.kill(-child.pid, signal);
            } catch {
                try {
                    child.kill(signal);
                } catch { /* already exited */ }
            }
        };

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
