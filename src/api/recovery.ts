/**
 * Startup crash recovery: clean up stale locks left by an interrupted backup or
 * restore, then mark any manifest still stuck at `running` as failed.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { rm, readdir } from 'node:fs/promises';
import { config, BACKUP_ID_RE, LIVE_DB, UPLOAD_TMP_PREFIX } from './core/config.js';
import { getRuntime } from './core/runtime.js';
import { appendActivity } from './core/activity.js';
import { readAllLocks, releaseLock } from './storage/locks.js';
import { readManifest, writeManifest, readAllManifests } from './storage/manifest.js';

/**
 * Recovers a single stale lock found at startup. Restore locks are normally
 * cleared by `finalizePendingRestore`; any restore lock still present here had
 * no marker and no flag, so it is treated as an interrupted restore.
 * @param lock  Parsed lock contents (`resource` plus metadata).
 */
async function recoverStaleLock(lock: Record<string, unknown>): Promise<void> {
    const resource = String(lock.resource);
    const { operation } = lock;

    if (resource === LIVE_DB) {
        const backupId = lock.backupId ? String(lock.backupId) : null;
        if (!backupId || !BACKUP_ID_RE.test(backupId)) return;
        const dir = join(config.backupDir, backupId);
        const m = await readManifest(dir);
        if (!m) return;
        if (operation === 'restore') {
            m.restoredAt = m.restoredAt || new Date().toISOString();
            m.restoreStatus = 'failed';
            m.restoreError = 'Directus restarted during restore — outcome unknown; the database may be partially restored. Re-run the restore.';
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

    if (!BACKUP_ID_RE.test(resource)) return;
    const dir = join(config.backupDir, resource);
    if (operation === 'delete') {
        try {
            await rm(dir, { recursive: true, force: true });
            getRuntime().logger?.info?.(`Completed interrupted delete: ${resource}`);
        } catch (e) {
            getRuntime().logger?.warn?.(`Could not complete interrupted delete for ${resource}: ${(e as Error).message}`);
        }
        appendActivity({ action: 'delete', backupId: resource, detail: 'Completed after restart during delete' }).catch(() => {});
    } else if (operation === 'import') {
        // A crash during extraction leaves a partial (possibly corrupt) backup
        // directory. Remove it so it cannot surface as a valid backup in the list.
        try {
            await rm(dir, { recursive: true, force: true });
            getRuntime().logger?.info?.(`Cleaned up partial import: ${resource}`);
        } catch (e) {
            getRuntime().logger?.warn?.(`Could not clean up partial import ${resource}: ${(e as Error).message}`);
        }
        appendActivity({ action: 'delete', backupId: resource, detail: 'Cleaned up after restart during import' }).catch(() => {});
    }
}

/**
 * Called once at startup, after `finalizePendingRestore`. Every lock found here
 * is stale by definition (a backup child cannot survive a restart, and completed
 * restores were already reconciled). Each lock is recovered and removed.
 */
export async function recoverStaleLocks(): Promise<void> {
    const locks = await readAllLocks();
    if (locks.length === 0) return;
    getRuntime().logger?.info?.(`Found ${locks.length} stale lock(s) on startup — cleaning up`);
    for (const lock of locks) {
        try {
            await recoverStaleLock(lock);
        } catch (e) {
            getRuntime().logger?.warn?.(`Lock recovery failed for ${String(lock.resource)}: ${(e as Error).message}`);
        }
        await releaseLock(String(lock.resource));
    }
}

/**
 * Removes stale upload temp files (`.upload-*.tar.gz`) left on disk by an
 * interrupted import. These are written before the per-backup lock is acquired,
 * so they have no lock to signal their presence. Safe to call at startup because
 * no in-progress import can survive a restart.
 */
export async function cleanStaleTmpFiles(): Promise<void> {
    let entries: string[];
    try {
        entries = await readdir(config.backupDir);
    } catch {
        return;
    }
    for (const name of entries) {
        if (!name.startsWith(UPLOAD_TMP_PREFIX)) continue;
        try {
            await rm(join(config.backupDir, name), { force: true });
            getRuntime().logger?.info?.(`Cleaned up stale upload temp file: ${name}`);
        } catch (e) {
            getRuntime().logger?.warn?.(`Could not remove stale upload temp file ${name}: ${(e as Error).message}`);
        }
    }
}

/**
 * Marks any manifest still in `status: "running"` as failed. Called once at
 * startup, after {@link recoverStaleLocks}, as a safety net for a backup whose
 * terminal manifest write never landed.
 */
export async function reconcileRunningManifests(): Promise<void> {
    const manifests = await readAllManifests();
    for (const m of manifests) {
        if (m.status !== 'running') continue;
        const id = String(m.id);
        if (!BACKUP_ID_RE.test(id)) continue;
        m.status = 'failed';
        m.error = m.error || 'Backup left running after restart — outcome unknown';
        m.finishedAt = m.finishedAt || new Date().toISOString();
        try {
            await writeManifest(join(config.backupDir, id), m);
            getRuntime().logger?.info?.(`Reconciled stale running manifest: ${id}`);
        } catch (e) {
            getRuntime().logger?.warn?.(`Could not reconcile running manifest ${id}: ${(e as Error).message}`);
        }
    }
}
