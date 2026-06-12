/**
 * Disk-usage measurement, quota checks, and retention/rotation enforcement.
 *
 * Stateless — paths are derived from {@link config} at call time.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readdir, stat, rm } from 'node:fs/promises';
import { config, BACKUP_ID_RE } from '../core/config.js';
import { readConfig } from './config-store.js';
import { readAllManifests, type Manifest } from './manifest.js';
import { acquireLock, releaseLock } from './locks.js';

/**
 * Recursively calculates the total size of a directory in bytes.
 * @param dir  Directory to measure.
 * @returns    Total size in bytes.
 */
export async function dirSizeBytes(dir: string): Promise<number> {
    let total = 0;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            total += await dirSizeBytes(full);
        } else if (entry.isFile()) {
            total += (await stat(full)).size;
        }
    }
    return total;
}

/**
 * Returns the available disk space on the backup volume in MB using `df`.
 * Returns `null` if `df` fails (e.g. In certain container environments).
 * @returns Free space in MB, or `null` if `df` failed.
 */
export function getFreeMB(): number | null {
    try {
        // `-P` forces POSIX output: exactly one logical line per filesystem, so a
        // long device name can never wrap onto a second physical line and shift
        // the "Available" column. Column index 3 is then reliably the free MB.
        const out = execFileSync('df', ['-P', '-m', config.backupDir], { encoding: 'utf8' });
        const line = out.trim().split('\n').pop() || '';
        const parts = line.split(/\s+/);
        const n = parseInt(parts[3], 10);
        // Number.isFinite (not `|| null`) so that a legitimate 0 MB free is
        // reported as 0 ("disk full") rather than null ("unknown, allow").
        return Number.isFinite(n) ? n : null;
    } catch (e) {
        console.warn('df failed:', (e as Error).message);
        return null;
    }
}

/** A single quota violation reason. */
export interface QuotaReason {
    code: string
    text: string
    freeMB?: number
    minFreeMB?: number
    usedMB?: number
    quotaMB?: number
}

/** Result of a quota check. */
export interface QuotaStatus {
    ok: boolean
    reasons: QuotaReason[]
    usedMB: number | null
    freeMB: number | null
}

/**
 * Checks both storage quota limits defined in the backup config.
 * @returns Quota status with reasons and measured sizes.
 */
export async function checkQuota(): Promise<QuotaStatus> {
    const cfg = await readConfig();
    const freeMB = getFreeMB();

    let usedMB: number | null = null;
    try {
        usedMB = Math.round(await dirSizeBytes(config.backupDir) / (1024 * 1024));
    } catch (e) {
        console.warn('Backup size check failed:', (e as Error).message);
    }

    const reasons: QuotaReason[] = [];
    if (cfg.minFreeMB > 0 && freeMB !== null && freeMB < cfg.minFreeMB) {
        reasons.push({ code: 'DISK_FULL', text: `Free space ${freeMB}MB < min ${cfg.minFreeMB}MB`, freeMB, minFreeMB: cfg.minFreeMB });
    }
    if (cfg.quotaMB > 0 && usedMB !== null && usedMB >= cfg.quotaMB) {
        reasons.push({ code: 'QUOTA_EXCEEDED', text: `Backup usage ${usedMB}MB >= quota ${cfg.quotaMB}MB`, usedMB, quotaMB: cfg.quotaMB });
    }

    return { ok: reasons.length === 0, reasons, usedMB, freeMB };
}

/**
 * Decides how many bytes an upload may write before it would eat into the
 * configured free-space margin. Pure function (no I/O).
 *
 * - `ok:false` → already at/below the margin, reject up front.
 * - `budgetBytes:null` → free space unknown, no streaming guard.
 * - `budgetBytes:number` → abort once the upload exceeds this many bytes.
 * @param freeMB     Free space in MB, or `null` if unknown (`df` failed).
 * @param minFreeMB  Configured minimum free space in MB.
 * @returns          Upload decision and byte budget.
 */
export function uploadBudget(freeMB: number | null, minFreeMB: number): { ok: boolean, budgetBytes: number | null } {
    if (freeMB === null) return { ok: true, budgetBytes: null };
    if (freeMB <= minFreeMB) return { ok: false, budgetBytes: 0 };
    return { ok: true, budgetBytes: (freeMB - minFreeMB) * 1024 * 1024 };
}

/**
 * Deletes the oldest scheduled backups one-by-one until the quota is satisfied.
 * @returns `true` if quota is now satisfied, `false` if not.
 */
export async function rotateForSpace(): Promise<boolean> {
    const all = await readAllManifests();
    const candidates = all
        .filter(m => m.source === 'scheduled' && m.status === 'success')
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    for (const m of candidates) {
        const id = String(m.id);
        if (!BACKUP_ID_RE.test(id)) continue;
        const dir = join(config.backupDir, id);
        // Respect the per-backup lock so rotation cannot delete a backup that a
        // download or restore is actively reading. A locked candidate is skipped
        // this round and reclaimed on a later run. The 'delete' operation reuses
        // the stale-lock recovery that finishes an interrupted removal on restart.
        const locked = await acquireLock(id, { backupId: id, startedAt: new Date().toISOString(), operation: 'delete' });
        if (!locked) {
            console.log(`Quota rotation: skip ${id} (in use)`);
            continue;
        }
        let deleted = false;
        try {
            await rm(dir, { recursive: true });
            deleted = true;
            console.log(`Quota rotation: deleted ${id}`);
        } catch (e) {
            console.warn(`Quota rotation: failed to delete ${id}:`, (e as Error).message);
        } finally {
            await releaseLock(id);
        }
        if (deleted) {
            const recheck = await checkQuota();
            if (recheck.ok) return true;
        }
    }
    return false;
}

/**
 * Enforces the configured retention policy by deleting old scheduled backups.
 * Manual backups are never auto-deleted.
 */
export async function enforceRetention(): Promise<void> {
    const cfg = await readConfig();
    if (cfg.retention === 'all') return;

    const all = await readAllManifests();
    const scheduled = all
        .filter(m => m.source === 'scheduled' && m.status === 'success')
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    if (scheduled.length === 0) return;

    let toDelete: Manifest[] = [];

    if (cfg.retention.startsWith('last-')) {
        const keep = parseInt(cfg.retention.split('-')[1], 10);
        toDelete = scheduled.slice(keep);
    } else if (cfg.retention.startsWith('days-')) {
        const days = parseInt(cfg.retention.split('-')[1], 10);
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        toDelete = scheduled.filter(m => String(m.createdAt || '') < cutoff);
    }

    let removed = 0;
    for (const m of toDelete) {
        const id = String(m.id);
        if (!BACKUP_ID_RE.test(id)) continue;
        const dir = join(config.backupDir, id);
        // Respect the per-backup lock so retention cannot delete a backup that a
        // download or restore is actively reading. A locked backup is skipped this
        // round and reclaimed on the next retention run. The 'delete' operation
        // reuses the stale-lock recovery that finishes an interrupted removal.
        const locked = await acquireLock(id, { backupId: id, startedAt: new Date().toISOString(), operation: 'delete' });
        if (!locked) {
            console.log(`Retention: skip ${id} (in use)`);
            continue;
        }
        try {
            await rm(dir, { recursive: true });
            removed += 1;
            console.log(`Retention: deleted ${id}`);
        } catch (e) {
            console.warn(`Retention: failed to delete ${id}:`, (e as Error).message);
        } finally {
            await releaseLock(id);
        }
    }

    if (removed > 0) {
        console.log(`Retention: removed ${removed} old scheduled backup(s)`);
    }
}
