/**
 * Per-resource lock management. Two lock domains: the global `LIVE_DB` sentinel
 * (backup, restore) and per-backup-ID locks (restore source, download, delete).
 *
 * Stateless — paths are derived from {@link config} at call time.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { open as fsOpen, readFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { config, LOCKS_DIR_NAME, LIVE_DB, BACKUP_ID_RE } from '../core/config.js';

/** Absolute path to the per-resource locks directory. */
function locksPath(): string {
    return join(config.backupDir, LOCKS_DIR_NAME);
}

/**
 * Validates a lock resource name. Only the live-system sentinel or a
 * well-formed backup ID may be locked; this keeps the resource usable as a
 * filename and prevents path traversal.
 * @param resource  Resource name.
 * @returns         `true` if the resource may be locked.
 */
function isValidLockResource(resource: string): boolean {
    return resource === LIVE_DB || BACKUP_ID_RE.test(String(resource));
}

/**
 * Builds the absolute path to a resource's lock file.
 * @param resource  Validated resource name.
 * @returns         Absolute lock file path.
 */
function lockFilePath(resource: string): string {
    return join(locksPath(), `${resource}.lock`);
}

/**
 * Reads a single resource's lock file.
 * @param resource  Lock resource (`LIVE_DB` or a backup ID).
 * @returns         Lock data, or `null` if not locked.
 */
export async function readLock(resource: string): Promise<Record<string, unknown> | null> {
    if (!isValidLockResource(resource)) return null;
    try {
        return JSON.parse(await readFile(lockFilePath(resource), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Reads every active lock. Used for startup recovery and health reporting.
 * @returns One entry per readable lock file.
 */
export async function readAllLocks(): Promise<Array<Record<string, unknown>>> {
    let names: string[];
    try {
        names = await readdir(locksPath());
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
    }
    const locks: Array<Record<string, unknown>> = [];
    for (const name of names) {
        if (!name.endsWith('.lock')) continue;
        try {
            locks.push(JSON.parse(await readFile(join(locksPath(), name), 'utf8')));
        } catch {
            const resource = name.slice(0, -'.lock'.length);
            // Recovery can safely unlink corrupt locks if the filename still maps
            // to a valid lock resource. Unknown filenames remain ignored.
            if (isValidLockResource(resource)) locks.push({ resource, corrupt: true });
        }
    }
    return locks;
}

/**
 * Attempts to acquire a resource lock using an exclusive `wx` open (atomic on
 * POSIX). The two lock domains are: the global `LIVE_DB` sentinel (backup,
 * restore) and per-backup-ID locks (restore source, download, delete). Restore
 * holds both and must always acquire `LIVE_DB` before the backup ID so the
 * acquisition order is total and deadlock-free.
 * @param resource  Lock resource (`LIVE_DB` or a backup ID).
 * @param data      Metadata written into the lock file.
 * @returns         `true` if acquired, `false` if already held.
 */
export async function acquireLock(resource: string, data: Record<string, unknown>): Promise<boolean> {
    if (!isValidLockResource(resource)) throw new Error(`Invalid lock resource: ${resource}`);
    await mkdir(locksPath(), { recursive: true });
    let fd;
    try {
        fd = await fsOpen(lockFilePath(resource), 'wx');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
    }
    try {
        await fd.writeFile(`${JSON.stringify({ resource, ...data }, null, 2)}\n`);
    } finally {
        await fd.close();
    }
    return true;
}

/**
 * Releases a resource lock. Silently ignores a missing lock and an invalid
 * resource name, so release paths can run unconditionally.
 * @param resource  Lock resource to release.
 */
export async function releaseLock(resource: string): Promise<void> {
    if (!isValidLockResource(resource)) return;
    try {
        await unlink(lockFilePath(resource));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
}
