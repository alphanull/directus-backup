/**
 * Installation sanity checks for the standalone backup extension.
 *
 * Detects incomplete deployments (Marketplace-only install, missing Dockerfile
 * steps, absent PostgreSQL client binaries, etc.) and surfaces actionable
 * remediation hints to the API and UI.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { access, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { config, RESTORE_FLAG_NAME, restoreMarkerPath } from './config.js';
import { resolveScriptsDir } from '../backup/process.js';
import type { SanityIssue, SanityReport } from '../../shared/types.js';

const SUPPORTED_DB_ADAPTERS = ['postgres'] as const;
const POSTGRES_BINARIES = ['pg_dump', 'pg_restore', 'psql'] as const;
const REQUIRED_BINARIES = ['tar', 'sha256sum', 'df'] as const;
const OPTIONAL_BINARIES = ['nc'] as const;

let cached: SanityReport | null = null;
let cachedAt = 0;
const CACHE_MS = 30_000;

/** Returns whether a shell command is on `PATH` (Alpine/BusyBox `command -v`). */
export function commandExists(cmd: string): Promise<boolean> {
    return new Promise(resolve => {
        const proc = spawn('sh', ['-c', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' });
        proc.on('close', code => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

/** Builds a single installation issue. */
function issue(
    code: string,
    severity: SanityIssue['severity'],
    message: string,
    fix?: string,
    params?: Record<string, string>
): SanityIssue {
    return { code, severity, message, fix, params };
}

/** Checks runner scripts and the configured DB adapter file. */
async function checkScripts(issues: SanityIssue[]): Promise<string | null> {
    try {
        const dir = await resolveScriptsDir();
        await access(join(dir, 'restore.sh'));
        if (!(SUPPORTED_DB_ADAPTERS as readonly string[]).includes(config.dbAdapter)) return dir;
        const adapter = join(dir, 'adapters', `${config.dbAdapter}.sh`);
        try {
            await access(adapter);
        } catch {
            issues.push(issue(
                'ADAPTER_MISSING',
                'error',
                `Database adapter script not found: adapters/${config.dbAdapter}.sh`,
                'Reinstall the extension package or verify DB_ADAPTER matches an adapter under scripts/adapters/.',
                { adapter: config.dbAdapter }
            ));
        }
        return dir;
    } catch (e) {
        issues.push(issue(
            'SCRIPTS_MISSING',
            'error',
            (e as Error).message || 'Runner scripts not found',
            'Install the full extension package (including scripts/) or verify EXTENSIONS_PATH points at the built bundle.'
        ));
        return null;
    }
}

/** Checks whether the configured database adapter is supported in this release. */
function checkSupportedAdapter(issues: SanityIssue[]): boolean {
    if ((SUPPORTED_DB_ADAPTERS as readonly string[]).includes(config.dbAdapter)) return true;
    issues.push(issue(
        'UNSUPPORTED_ADAPTER',
        'error',
        `Database adapter "${config.dbAdapter}" is not supported in this release`,
        `Use DB_ADAPTER=postgres. Supported adapters: ${SUPPORTED_DB_ADAPTERS.join(', ')}.`,
        { adapter: config.dbAdapter, supported: SUPPORTED_DB_ADAPTERS.join(', ') }
    ));
    return false;
}

/** Verifies BACKUP_DIR exists and is writable by the Directus user. */
async function checkBackupDirWritable(issues: SanityIssue[]): Promise<void> {
    const probe = join(config.backupDir, `.sanity-${process.pid}`);
    try {
        await writeFile(probe, 'ok');
        await rm(probe);
    } catch (e) {
        issues.push(issue(
            'BACKUP_DIR_NOT_WRITABLE',
            'error',
            `Backup directory is not writable: ${config.backupDir}`,
            'Mount a backup volume at BACKUP_DIR and ensure it is owned by the Directus user (see installation.md).',
            { path: config.backupDir }
        ));
    }
}

/** Checks container boot hooks required for restart-based restores. */
async function checkRestoreBootstrap(issues: SanityIssue[]): Promise<void> {
    // Docker restart policy (restart: unless-stopped) is not readable from inside
    // the container — no reliable in-process check. Document it in installation.md;
    // misconfiguration surfaces at runtime via PENDING_RESTORE_STUCK / unfired restore.
    try {
        const raw = await readFile('/entrypoint.sh', 'utf8');
        if (!raw.includes('restore.sh')) {
            issues.push(issue(
                'ENTRYPOINT_NOT_CONFIGURED',
                'error',
                'Container entrypoint does not run restore.sh before Directus starts',
                'Override ENTRYPOINT with the extension entrypoint stub (see examples/entrypoint.sh and installation.md).'
            ));
        }
    } catch {
        issues.push(issue(
            'ENTRYPOINT_NOT_CONFIGURED',
            'error',
            'Custom container entrypoint (/entrypoint.sh) not found',
            'Extend the Directus image with the restore entrypoint stub from examples/entrypoint.sh.'
        ));
    }

    try {
        const cmdline = (await readFile('/proc/1/cmdline', 'utf8')).replace(/\0/g, ' ');
        // Accept pm2-runtime (stock Directus start command) and bare node/node.js processes
        // (e.g. `exec node cli.js start`). Both exit on SIGTERM so Docker restart fires.
        // Reject plain shells (sh/bash/ash) as PID 1: they don't forward SIGTERM to children
        // and the container won't exit, breaking the restart-based restore mechanism.
        const isShell = /\b(sh|bash|ash|dash)\b/.test(cmdline) && !/\bpm2\b/i.test(cmdline) && !/\bnode\b/i.test(cmdline);
        if (isShell) {
            issues.push(issue(
                'RESTART_HANDLER_MISSING',
                'error',
                'PID 1 is a shell — SIGTERM will not reach Directus and container restores will not work',
                'Use `exec pm2-runtime start ecosystem.config.cjs` or `exec node cli.js start` so a signal-forwarding process is PID 1, and set restart: unless-stopped in Compose.'
            ));
        } else if (!/\bpm2\b/i.test(cmdline) && !/\bnode\b/i.test(cmdline)) {
            issues.push(issue(
                'RESTART_HANDLER_MISSING',
                'error',
                'PID 1 does not look like pm2-runtime or node — container restart restores may not work',
                'Use the stock Directus start command so PID 1 is pm2-runtime, and set restart: unless-stopped in Compose.'
            ));
        }
    } catch {
        issues.push(issue(
            'RESTART_HANDLER_UNKNOWN',
            'warning',
            'Could not verify PID 1 (non-Linux host) — restore restart mechanism not checked',
            'On production Linux containers, PID 1 must be pm2-runtime and restart: unless-stopped must be set.'
        ));
    }

    try {
        await access(restoreMarkerPath(RESTORE_FLAG_NAME));
        issues.push(issue(
            'PENDING_RESTORE_STUCK',
            'error',
            'A restore was armed but never consumed (.pending_restore is still present)',
            'Restart the container so the entrypoint runs restore.sh, or remove the stale flag/locks after verifying the deployment.'
        ));
    } catch { /* no stuck flag */ }
}

/** Runs every installation check and returns a structured report. */
export async function runSanityCheck(): Promise<SanityReport> {
    const issues: SanityIssue[] = [];

    const adapterSupported = checkSupportedAdapter(issues);
    await checkScripts(issues);

    for (const bin of REQUIRED_BINARIES) {
        if (!await commandExists(bin)) {
            issues.push(issue(
                'BINARY_MISSING',
                'error',
                `Required command not found: ${bin}`,
                'Install the missing utility in the Directus container image.',
                { binary: bin }
            ));
        }
    }
    if (adapterSupported) {
        for (const bin of POSTGRES_BINARIES) {
            if (!await commandExists(bin)) {
                issues.push(issue(
                    'BINARY_MISSING',
                    'error',
                    `Required command not found: ${bin}`,
                    'Install postgresql-client in the Directus image (apk add postgresql16-client — see installation.md).',
                    { binary: bin }
                ));
            }
        }
    }

    for (const bin of OPTIONAL_BINARIES) {
        if (!await commandExists(bin)) {
            issues.push(issue(
                'BINARY_MISSING',
                'warning',
                `Optional command not found: ${bin}`,
                'Install netcat-openbsd (or busybox nc) so restore.sh can flush Redis after a restore.',
                { binary: bin }
            ));
        }
    }
    if (config.runnerTimeoutMs > 0 && !await commandExists('setsid')) {
        issues.push(issue(
            'SETSID_MISSING',
            'error',
            'setsid is required for boot-time restore timeout enforcement',
            'Install util-linux (setsid) or set RUNNER_TIMEOUT_MIN=0 to explicitly disable restore timeout enforcement.'
        ));
    }

    await checkBackupDirWritable(issues);
    await checkRestoreBootstrap(issues);

    const errors = issues.filter(i => i.severity === 'error');
    const backupBlockers = new Set([
        'SCRIPTS_MISSING', 'ADAPTER_MISSING', 'UNSUPPORTED_ADAPTER', 'BINARY_MISSING', 'BACKUP_DIR_NOT_WRITABLE'
    ]);
    const restoreBlockers = new Set([
        ...backupBlockers,
        'ENTRYPOINT_NOT_CONFIGURED',
        'RESTART_HANDLER_MISSING',
        'PENDING_RESTORE_STUCK',
        'SETSID_MISSING'
    ]);

    const operational = !errors.some(i => backupBlockers.has(i.code));
    const restoreReady = !errors.some(i => restoreBlockers.has(i.code));

    return {
        ok: errors.length === 0,
        operational,
        restoreReady,
        issues,
        checkedAt: new Date().toISOString()
    };
}

/** Returns a cached sanity report (refreshed every {@link CACHE_MS}). */
export async function getSanityReport(force = false): Promise<SanityReport> {
    if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached;
    cached = await runSanityCheck();
    cachedAt = Date.now();
    return cached;
}

/** Clears the cached report (for tests). */
export function resetSanityCache(): void {
    cached = null;
    cachedAt = 0;
}

/** First blocking error message for API responses. */
export function installationError(report: SanityReport): string {
    const err = report.issues.find(i => i.severity === 'error');
    return err?.message || 'Backup extension installation is incomplete';
}
