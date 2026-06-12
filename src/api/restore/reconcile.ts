/**
 * Boot-time reconciliation of a completed (or abandoned) restore. Reads the
 * handshake marker left by `restore.sh`, updates the manifest with the restore
 * outcome, appends activity, fires the post-restore hook on success, releases
 * the locks, and removes the marker.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import {
    config,
    BACKUP_ID_RE,
    LIVE_DB,
    RESTORE_FLAG_NAME,
    RESTORE_PROCESSING_NAME,
    RESTORE_DONE_NAME,
    RESTORE_FAILED_NAME,
    restoreMarkerPath
} from '../core/config.js';
import { getRuntime } from '../core/runtime.js';
import { appendActivity } from '../core/activity.js';
import { releaseLock } from '../storage/locks.js';
import { readManifest, writeManifest } from '../storage/manifest.js';
import { parseRestoreVerify, parseRestoreResult } from '../storage/verify.js';
import { triggerPostRestoreHook } from './restore.js';

/**
 * Reverses the sh single-quoting applied by `restore.ts`'s `shQuote` when the
 * extension writes the flag. A value wrapped in single quotes is unwrapped and
 * its `'\''` escapes are collapsed back to `'`. Values written without quotes
 * (e.g. By `recover.sh`) are returned unchanged, so both writers are supported.
 */
function unquoteFlagValue(value: string): string {
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).split("'\\''").join("'");
    }
    return value;
}

/** Parses a `KEY=VALUE` flag/marker file into a map. */
function parseFlagFile(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        out[line.slice(0, eq).trim()] = unquoteFlagValue(line.slice(eq + 1).trim());
    }
    return out;
}

/**
 * Reconciles a completed (or abandoned) restore on Directus boot.
 *
 * Marker precedence and meaning:
 * - `.restore_done`       → restore.sh ran and the restore succeeded (verify
 * may still report count warnings).
 * - `.restore_failed`     → restore.sh ran and the restore failed.
 * - `.restore_processing` → restore.sh crashed mid-restore → failed, outcome
 * unknown (DB may be partially restored). Never re-run (loop guard).
 * - `.pending_restore`    → restore.sh never consumed the flag → the restart
 * mechanism is misconfigured (missing ENTRYPOINT override or restart policy).
 * DB untouched; reported as failed with a clear hint.
 */
export async function finalizePendingRestore(): Promise<void> {
    const candidates: Array<{ name: string, outcome: 'done' | 'failed' | 'crashed' | 'unfired' }> = [
        { name: RESTORE_DONE_NAME, outcome: 'done' },
        { name: RESTORE_FAILED_NAME, outcome: 'failed' },
        { name: RESTORE_PROCESSING_NAME, outcome: 'crashed' },
        { name: RESTORE_FLAG_NAME, outcome: 'unfired' }
    ];

    for (const { name, outcome } of candidates) {
        const path = restoreMarkerPath(name);
        let raw: string;
        try {
            raw = await readFile(path, 'utf8');
        } catch {
            continue;
        }

        const vars = parseFlagFile(raw);
        const backupId = vars.BACKUP_ID;
        if (!backupId || !BACKUP_ID_RE.test(backupId)) {
            await rm(path, { force: true });
            continue;
        }
        const backupPath = join(config.backupDir, backupId);

        try {
            await reconcileRestoreOutcome(backupId, backupPath, outcome);
        } catch (e) {
            getRuntime().logger?.error?.(`Restore reconcile failed for ${backupId}: ${(e as Error).message}`);
        }

        await releaseLock(backupId);
        await releaseLock(LIVE_DB);
        await rm(path, { force: true });
    }
}

/** Applies a restore outcome to the manifest + activity log + hook. */
async function reconcileRestoreOutcome(backupId: string, backupPath: string, outcome: 'done' | 'failed' | 'crashed' | 'unfired'): Promise<void> {
    const manifest = await readManifest(backupPath);
    if (!manifest) {
        getRuntime().logger?.warn?.(`Restore reconcile: manifest missing for ${backupId}`);
        return;
    }

    manifest.restoredAt = new Date().toISOString();

    if (outcome === 'done') {
        const restoreResult = await parseRestoreResult(backupPath);
        if (restoreResult) manifest.restore = restoreResult;
        manifest.restoreStatus = 'success';
        delete manifest.restoreError;
        try {
            manifest.restoreVerify = await parseRestoreVerify(backupPath);
        } catch { /* restore-verify.txt absent (legacy / no DB) */ }
    } else {
        manifest.restoreStatus = 'failed';
        manifest.restoreError = await deriveRestoreError(backupPath, outcome);
    }

    await writeManifest(backupPath, manifest);

    appendActivity({
        action: manifest.restoreStatus === 'success' ? 'restore_success' : 'restore_failed',
        backupId,
        detail: manifest.restoreStatus === 'success' ? undefined : String(manifest.restoreError)
    }).catch(() => {});

    if (manifest.restoreStatus === 'success') {
        await triggerPostRestoreHook(backupId);
    }
}

/** Builds a human-readable restore error from artefacts and the failure mode. */
async function deriveRestoreError(backupPath: string, outcome: 'failed' | 'crashed' | 'unfired'): Promise<string> {
    if (outcome === 'unfired') {
        return 'Restore did not run: the container did not restart into the restore entrypoint. '
          + 'Verify the Dockerfile ENTRYPOINT override and the "restart: unless-stopped" policy. '
          + 'The database was not modified.';
    }
    if (outcome === 'crashed') {
        return 'The restore was interrupted before it finished — outcome unknown; the database may be '
          + 'partially restored. Review runner.log and re-run the restore.';
    }
    // outcome === 'failed': prefer the explicit error file, then the runner log tail.
    try {
        const msg = (await readFile(join(backupPath, 'restore-error.txt'), 'utf8')).trim();
        if (msg) return msg;
    } catch { /* no restore-error.txt */ }
    try {
        const log = (await readFile(join(backupPath, 'runner.log'), 'utf8')).trim();
        const tail = log.split('\n').slice(-20).join('\n');
        if (tail) return tail;
    } catch { /* no runner.log */ }
    return 'Restore failed (no further detail available)';
}
