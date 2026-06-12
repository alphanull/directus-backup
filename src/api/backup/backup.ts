/**
 * Live backup execution. Backups run exactly as in the sidecar: `backup.sh` is
 * spawned as a child process and {@link monitorProcess} finalises the manifest
 * on exit, enforcing retention (scheduled) or notifying admins on failure.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join, resolve as resolvePath } from 'node:path';
import { access, readFile, rm } from 'node:fs/promises';
import { config, LIVE_DB } from '../core/config.js';
import { notifyAdmins, fetchDirectusVersion } from '../core/notify.js';
import { getRuntime } from '../core/runtime.js';
import { appendActivity } from '../core/activity.js';
import { readConfig } from '../storage/config-store.js';
import { readManifest, writeManifest, type Manifest } from '../storage/manifest.js';
import type { BackupManifest, BackupSource } from '../../shared/types.js';
import { acquireLock, releaseLock } from '../storage/locks.js';
import { checkQuota, rotateForSpace, dirSizeBytes, enforceRetention } from '../storage/space.js';
import { parseVerifyData } from '../storage/verify.js';
import {
    resolveScriptsDir,
    buildRunnerEnv,
    buildScopeEnv,
    spawnRunner,
    cancelledIds,
    type ActionResult
} from './process.js';
import { getSanityReport, installationError } from '../core/sanity.js';

/** Removes a failed partial backup directory so failed runs do not consume quota. */
async function removeFailedBackupDir(dir: string, backupId: string): Promise<void> {
    try {
        await rm(dir, { recursive: true, force: true });
    } catch (e) {
        getRuntime().logger?.warn?.(`Could not remove failed backup directory ${backupId}: ${(e as Error).message}`);
    }
}

/**
 * Monitors a backup child process. Fire-and-forget: resolves internally when
 * the process exits, then writes the terminal manifest and enforces retention
 * (scheduled) or notifies admins (scheduled failure).
 * @param runnerPromise  Resolves when the spawned runner exits.
 * @param backupId       Backup ID being monitored.
 * @param source         `manual` or `scheduled`.
 */
export function monitorProcess(runnerPromise: Promise<{ exitCode: number }>, backupId: string, source: BackupSource): void {
    const dir = join(config.backupDir, backupId);

    runnerPromise
        .then(async({ exitCode: code }) => {
            getRuntime().logger?.info?.(`Runner exited: ${backupId} code=${code}`);
            const finishedAt = new Date().toISOString();

            const cancelled = cancelledIds.has(backupId);
            cancelledIds.delete(backupId);

            if (cancelled) {
                try {
                    await rm(dir, { recursive: true, force: true });
                } catch (e) {
                    getRuntime().logger?.warn?.(`Could not remove cancelled backup directory ${backupId}: ${(e as Error).message}`);
                }
                await releaseLock(LIVE_DB);
                appendActivity({ action: 'backup_cancelled', backupId, source }).catch(() => {});
                return;
            }

            const manifest: Manifest = await readManifest(dir) || {
                id: backupId,
                createdAt: finishedAt,
                label: backupId.split('__')[2] || 'unknown',
                source: source || 'manual',
                status: 'running',
                tool: { name: config.dbAdapter }
            };

            manifest.status = code === 0 ? 'success' : 'failed';
            manifest.finishedAt = finishedAt;
            if (code !== 0) {
                let errDetail = '';
                try {
                    const log = (await readFile(join(dir, 'runner.log'), 'utf8')).trim();
                    errDetail = log.split('\n').slice(-20).join('\n');
                } catch { /* no runner.log */ }
                manifest.error = errDetail || `Runner exited with code ${code}`;
                await writeManifest(dir, manifest);
                await removeFailedBackupDir(dir, backupId);
                await releaseLock(LIVE_DB);
                appendActivity({ action: 'backup_failed', backupId, source, detail: String(manifest.error) }).catch(() => {});
                if (source === 'scheduled') {
                    notifyAdmins(`Scheduled backup failed: ${backupId}`, String(manifest.error || `Runner exited with code ${code}`)).catch(() => {});
                }
                return;
            }

            delete manifest.error;
            try {
                manifest.sizeBytes = await dirSizeBytes(dir);
            } catch (e) {
                getRuntime().logger?.warn?.(`Could not calculate size for ${backupId}: ${(e as Error).message}`);
            }
            try {
                const { collections, ...verify } = await parseVerifyData(dir);
                manifest.verify = verify;
                if (manifest.scope && Array.isArray(collections)) {
                    (manifest.scope as { collections?: string[] }).collections = collections;
                }
            } catch (e) {
                getRuntime().logger?.warn?.(`Could not read verify data for ${backupId}: ${(e as Error).message}`);
            }

            await writeManifest(dir, manifest);
            await releaseLock(LIVE_DB);

            appendActivity({
                action: code === 0 ? 'backup_success' : 'backup_failed',
                backupId,
                source,
                detail: code === 0 ? undefined : String(manifest.error)
            }).catch(() => {});

            if (source === 'scheduled') {
                try {
                    await enforceRetention();
                } catch (e) {
                    getRuntime().logger?.warn?.(`Retention enforcement failed: ${(e as Error).message}`);
                }
            }
        })
        .catch(async err => {
            getRuntime().logger?.error?.(`Monitor error for ${backupId}: ${err.message}`);
            try {
                const m = await readManifest(dir);
                if (m && m.status === 'running') {
                    m.status = 'failed';
                    m.error = `Backup monitor failed to persist result: ${err.message}`;
                    m.finishedAt = new Date().toISOString();
                    await writeManifest(dir, m);
                }
                await releaseLock(LIVE_DB);
            } catch (e2) {
                getRuntime().logger?.error?.(`Could not finalize manifest after monitor error for ${backupId} — keeping LIVE_DB lock as recovery anchor: ${(e2 as Error).message}`);
            }
        });
}

/**
 * Validates quota, acquires the lock, spawns `backup.sh` as a child process, and
 * delegates post-exit handling to {@link monitorProcess}.
 * @param backupId                           Pre-generated backup ID.
 * @param source                             `manual` or `scheduled`.
 * @param scopeOverride                      Per-run scope (manual, allowlist); falls back to the configured `backupScope` (blocklist).
 * @param scopeOverride.database             Include the database dump.
 * @param scopeOverride.assets               Include uploaded assets.
 * @param scopeOverride.extensions           Include installed extensions.
 * @param scopeOverride.includeCollections   Allowlist of collections (per-run scope).
 * @param scopeOverride.excludedCollections  Blocklist of collections (global config scope).
 * @returns                                  Acceptance result, or an error with HTTP status.
 */
export async function startBackup(
    backupId: string,
    source: BackupSource,
    scopeOverride?: { database: boolean, assets: boolean, extensions: boolean, includeCollections?: string[], excludedCollections?: string[] }
): Promise<ActionResult> {
    const sanity = await getSanityReport();
    if (!sanity.operational) {
        return {
            ok: false,
            status: 503,
            error: installationError(sanity),
            code: 'INSTALL_INCOMPLETE'
        };
    }

    const backupPath = resolvePath(config.backupDir, backupId);

    let quota = await checkQuota();
    if (!quota.ok) {
        if (source === 'scheduled') {
            getRuntime().logger?.warn?.(`Quota exceeded before scheduled backup, rotating: ${quota.reasons.map(r => r.text).join('; ')}`);
            const freed = await rotateForSpace();
            if (freed) quota = await checkQuota();
        }
        if (!quota.ok) {
            const msg = quota.reasons.map(r => r.text).join('; ');
            appendActivity({ action: 'backup_failed', backupId, source, detail: `Quota: ${msg}` }).catch(() => {});
            if (source === 'scheduled') {
                notifyAdmins('Scheduled backup skipped: storage limit reached', msg).catch(() => {});
            }
            return { ok: false, status: 507, error: msg };
        }
    }

    const now = new Date().toISOString();
    const label = backupId.split('__')[2] || 'manual';

    const locked = await acquireLock(LIVE_DB, { backupId, startedAt: now, source, operation: 'backup' });
    if (!locked) {
        appendActivity({ action: 'backup_failed', backupId, source, detail: 'Another backup or restore is already running' }).catch(() => {});
        return { ok: false, status: 409, error: 'Another backup or restore is already running' };
    }

    const [directusVersion, cfg] = await Promise.all([fetchDirectusVersion(), readConfig()]);
    const scope = scopeOverride || cfg.backupScope;
    const scopeEnv = buildScopeEnv('backup', scope);
    const includedCollections = (scope as { includeCollections?: string[] }).includeCollections || [];

    const manifest: BackupManifest = {
        id: backupId,
        createdAt: now,
        label,
        source,
        status: 'running',
        tool: { name: config.dbAdapter },
        scope: {
            database: scope.database,
            assets: scope.assets,
            extensions: scope.extensions,
            ...scope.excludedCollections && scope.excludedCollections.length > 0
                ? { excludedCollections: [...scope.excludedCollections] }
                : { includedCollections: [...includedCollections] }
        },
        ...directusVersion ? { directusVersion } : {}
    };

    const pathExists = await access(backupPath).then(() => true).catch(() => false);
    if (pathExists) {
        await releaseLock(LIVE_DB);
        appendActivity({ action: 'backup_failed', backupId, source, detail: 'Backup directory already exists' }).catch(() => {});
        return { ok: false, status: 409, error: `Backup directory already exists: ${backupId}` };
    }

    const logPath = join(backupPath, 'runner.log');
    let runnerPromise: Promise<{ exitCode: number, timedOut: boolean }>;
    try {
        await writeManifest(backupPath, manifest);
        const command = await resolveScriptsDir().then(d => join(d, 'backup.sh'));
        const env = buildRunnerEnv(backupId, backupPath, scopeEnv);
        runnerPromise = spawnRunner(env, logPath, { command });
    } catch (e) {
        const errMsg = (e as Error).message || String(e);
        getRuntime().logger?.error?.(`Failed to start backup: ${errMsg}`);
        manifest.status = 'failed';
        manifest.error = `Failed to start backup: ${errMsg}`;
        manifest.finishedAt = new Date().toISOString();
        try {
            await writeManifest(backupPath, manifest);
        } catch (writeErr) {
            getRuntime().logger?.error?.(`Could not persist failed-status manifest: ${(writeErr as Error).message}`);
        }
        await removeFailedBackupDir(backupPath, backupId);
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
