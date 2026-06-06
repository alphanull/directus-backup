/**
 * All filesystem I/O: lock management, manifest read/write, backup config,
 * quota checks, retention enforcement, and verify-data parsing.
 * This module is stateless — every function derives its paths from the
 * config constants and accepts/returns plain data objects.
 * @author   Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open as fsOpen, readFile, readdir, stat, writeFile, rename, mkdir, unlink, rm } from 'node:fs/promises';
import { BACKUP_DIR, LOCKS_DIR_NAME, LIVE_DB, MANIFEST_FILE, CONFIG_FILE, BACKUP_ID_RE, COLLECTION_NAME_RE, VALID_SCHEDULES, VALID_RETENTIONS, DEFAULT_CONFIG, DEFAULT_SCOPE } from './config.js';

const LOCKS_PATH = join(BACKUP_DIR, LOCKS_DIR_NAME);

/**
 * Validates a lock resource name. Only the live-system sentinel or a
 * well-formed backup ID may be locked; this keeps the resource usable as a
 * filename and prevents path traversal.
 * @param   {string}  resource  Resource name.
 * @returns {boolean}           `true` if the resource may be locked.
 */
function isValidLockResource(resource) {
    return resource === LIVE_DB || BACKUP_ID_RE.test(String(resource));
}

/**
 * Builds the absolute path to a resource's lock file.
 * @param   {string} resource  Validated resource name.
 * @returns {string}           Absolute lock file path.
 */
function lockPath(resource) {
    return join(LOCKS_PATH, `${resource}.lock`);
}

/**
 * Normalises a scope object, filling in defaults for missing/invalid fields.
 * The global config scope is blocklist-based (`excludedCollections`); a string
 * array is always returned so new collections are included by default.
 * @param   {unknown}                                                                                    raw  Raw scope value of any shape; non-objects yield all defaults.
 * @returns {{ database: boolean, assets: boolean, extensions: boolean, excludedCollections: string[] }}      Normalised scope with defaults filled in.
 */
function normalizeScope(raw) {
    const s = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {});
    return {
        database: typeof s.database === 'boolean' ? s.database : DEFAULT_SCOPE.database,
        assets: typeof s.assets === 'boolean' ? s.assets : DEFAULT_SCOPE.assets,
        extensions: typeof s.extensions === 'boolean' ? s.extensions : DEFAULT_SCOPE.extensions,
        excludedCollections: Array.isArray(s.excludedCollections)
            ? /** @type {string[]} */ (/** @type {unknown[]} */ (s.excludedCollections).filter(v => typeof v === 'string' && COLLECTION_NAME_RE.test(v)))
            : []
    };
}

/**
 * Reads and validates `backup-config.json`. Falls back to {@link DEFAULT_CONFIG}
 * for any missing or invalid fields.
 * @returns {Promise<{ schedule: string, scheduleMinute: number, scheduleHour: number, retention: string, quotaMB: number, minFreeMB: number, backupScope: ReturnType<typeof normalizeScope> }>} The validated config, with defaults applied to missing or invalid fields.
 */
export async function readConfig() {
    try {
        const raw = await readFile(join(BACKUP_DIR, CONFIG_FILE), 'utf8');
        const cfg = JSON.parse(raw);
        const toInt = (/** @type {unknown} */ v, /** @type {number} */ min, /** @type {number} */ max, /** @type {number} */ def) => {
            const n = Math.floor(Number(v));
            return Number.isFinite(n) && n >= min && n <= max ? n : def;
        };
        return {
            schedule: VALID_SCHEDULES.includes(cfg.schedule) ? cfg.schedule : 'off',
            scheduleMinute: toInt(cfg.scheduleMinute, 0, 59, 0),
            scheduleHour: toInt(cfg.scheduleHour, 0, 23, 0),
            retention: VALID_RETENTIONS.includes(cfg.retention) ? cfg.retention : 'all',
            quotaMB: Number.isFinite(cfg.quotaMB) && cfg.quotaMB >= 0 ? cfg.quotaMB : 0,
            minFreeMB: Number.isFinite(cfg.minFreeMB) && cfg.minFreeMB >= 0 ? cfg.minFreeMB : 100,
            backupScope: normalizeScope(cfg.backupScope)
        };
    } catch {
        return { ...DEFAULT_CONFIG, backupScope: { ...DEFAULT_SCOPE } };
    }
}

/**
 * Atomically writes the backup config using a temp-file + rename pattern.
 * @param {{ schedule: string, retention: string, quotaMB: number, minFreeMB: number }} cfg  Config object to persist.
 */
export async function writeConfig(cfg) {
    const target = join(BACKUP_DIR, CONFIG_FILE);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    await rename(tmp, target);
}

// ── Lock management ───────────────────────────────────────────

/**
 * Reads a single resource's lock file.
 * @param   {string}                                resource  Lock resource (`LIVE_DB` or a backup ID).
 * @returns {Promise<Record<string, unknown>|null>}           Lock data, or `null` if not locked.
 */
export async function readLock(resource) {
    if (!isValidLockResource(resource)) return null;
    try {
        return JSON.parse(await readFile(lockPath(resource), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Reads every active lock. Used for startup recovery and health reporting.
 * @returns {Promise<Array<Record<string, unknown>>>} One entry per readable lock file.
 */
export async function readAllLocks() {
    let names;
    try {
        names = await readdir(LOCKS_PATH);
    } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
        throw e;
    }
    const locks = [];
    for (const name of names) {
        if (!name.endsWith('.lock')) continue;
        try {
            locks.push(JSON.parse(await readFile(join(LOCKS_PATH, name), 'utf8')));
        } catch {
            // Ignore unreadable or garbage lock files; recovery still unlinks them.
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
 * @param   {string}                  resource  Lock resource (`LIVE_DB` or a backup ID).
 * @param   {Record<string, unknown>} data      Metadata written into the lock file.
 * @returns {Promise<boolean>}                  `true` if acquired, `false` if already held.
 */
export async function acquireLock(resource, data) {
    if (!isValidLockResource(resource)) throw new Error(`Invalid lock resource: ${resource}`);
    await mkdir(LOCKS_PATH, { recursive: true });
    let fd;
    try {
        fd = await fsOpen(lockPath(resource), 'wx');
    } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === 'EEXIST') return false;
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
 * @param {string} resource  Lock resource to release.
 */
export async function releaseLock(resource) {
    if (!isValidLockResource(resource)) return;
    try {
        await unlink(lockPath(resource));
    } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
    }
}

// ── Manifest helpers ──────────────────────────────────────────

/**
 * Atomically writes a manifest (`backup.json`) into the given directory.
 * Creates the directory if it does not exist.
 * @param {string}                  dir   Absolute path to the backup directory.
 * @param {Record<string, unknown>} data  Manifest contents to serialise.
 */
export async function writeManifest(dir, data) {
    await mkdir(dir, { recursive: true });
    const target = join(dir, MANIFEST_FILE);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, target);
}

/**
 * Reads and parses the manifest from a backup directory.
 * @param   {string}                                dir  Absolute path to the backup directory.
 * @returns {Promise<Record<string, unknown>|null>}      Parsed manifest, or `null` on any error.
 */
export async function readManifest(dir) {
    try {
        return JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Reads all valid backup manifests from the backup root directory.
 * Silently skips entries that are not valid backup ID directories or lack a manifest.
 * @returns {Promise<Record<string, unknown>[]>} All valid backup manifests found in the backup root.
 */
export async function readAllManifests() {
    try {
        const entries = await readdir(BACKUP_DIR, { withFileTypes: true });
        const manifests = [];
        for (const e of entries) {
            if (!e.isDirectory() || !BACKUP_ID_RE.test(e.name)) continue;
            const m = await readManifest(join(BACKUP_DIR, e.name));
            if (m) manifests.push(m);
        }
        return manifests;
    } catch {
        return [];
    }
}

// ── Directory size + free space ───────────────────────────────

/**
 * Recursively calculates the total size of a directory in bytes.
 * @param   {string}          dir  Directory to measure.
 * @returns {Promise<number>}      Total size in bytes.
 */
export async function dirSizeBytes(dir) {
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
 * @returns {number|null} Free space in MB, or `null` if `df` failed.
 */
export function getFreeMB() {
    try {
        // `-P` forces POSIX output: exactly one logical line per filesystem, so a
        // long device name can never wrap onto a second physical line and shift
        // the "Available" column. Column index 3 is then reliably the free MB.
        const out = execFileSync('df', ['-P', '-m', BACKUP_DIR], { encoding: 'utf8' });
        const line = out.trim().split('\n').pop() || '';
        const parts = line.split(/\s+/);
        const n = parseInt(parts[3], 10);
        // Number.isFinite (not `|| null`) so that a legitimate 0 MB free is
        // reported as 0 ("disk full") rather than null ("unknown, allow").
        return Number.isFinite(n) ? n : null;
    } catch (e) {
        console.warn('df failed:', /** @type {Error} */ (e).message);
        return null;
    }
}

// ── Verify helpers ────────────────────────────────────────────

/**
 * Parses the verify artefacts written by the runner after a successful backup.
 * Throws if either `checksums.sha256` or `db-counts.txt` is missing.
 * @param   {string}                                                                                                                      dir  Backup directory.
 * @returns {Promise<{ checksums: Record<string,string>, dumpTables?: number, dbCounts: Record<string,number>, collections?: string[] }>}      Parsed checksums, DB row counts, and the positive collection index.
 */
export async function parseVerifyData(dir) {
    const checksumRaw = await readFile(join(dir, 'checksums.sha256'), 'utf8');
    const countsRaw = await readFile(join(dir, 'db-counts.txt'), 'utf8');

    /** @type {Record<string, string>} */
    const checksums = {};
    for (const line of checksumRaw.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) checksums[parts[parts.length - 1]] = parts[0];
    }

    /** @type {Record<string, number>} */
    const dbCounts = {};
    let dumpTables = /** @type {number | null} */ (null);
    for (const line of countsRaw.trim().split('\n')) {
        if (!line.trim()) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) continue;
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();
        if (key === '__dump_tables') {
            dumpTables = parseInt(value, 10);
        } else {
            dbCounts[key] = parseInt(value, 10);
        }
    }

    // Positive collection index (db-tables.txt). Optional: absent for backups
    // that predate this feature, so a missing file is not an error.
    /** @type {string[]|undefined} */
    let collections;
    try {
        const tablesRaw = await readFile(join(dir, 'db-tables.txt'), 'utf8');
        collections = tablesRaw.split('\n').map(l => l.trim()).filter(Boolean);
    } catch { /* no db-tables.txt (legacy backup) */ }

    return { checksums, ...dumpTables === null ? {} : { dumpTables }, dbCounts, ...collections ? { collections } : {} };
}

/**
 * Parses `restore-verify.txt` written by the runner after a completed restore.
 * Throws if the file is absent (expected for backups predating the verify feature).
 * @param   {string}                                                                                dir  Backup directory.
 * @returns {Promise<{ status: 'ok'|'warn', mismatches: number, details?: Record<string,string> }>}      Parsed restore-verification result.
 */
export async function parseRestoreVerify(dir) {
    const raw = await readFile(join(dir, 'restore-verify.txt'), 'utf8');
    /** @type {Record<string, string>} */
    const result = {};
    for (const line of raw.trim().split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) continue;
        result[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
    }
    const mismatches = parseInt(result.mismatches || '0', 10);
    /** @type {Record<string, string>} */
    const details = {};
    for (const [k, v] of Object.entries(result)) {
        if (k.startsWith('mismatch.')) details[k.slice(9)] = v;
    }
    return {
        status: mismatches === 0 ? 'ok' : 'warn',
        mismatches,
        ...mismatches > 0 ? { details } : {}
    };
}

/**
 * Parses `restore-result.txt` written by the runner: per-component outcome of a
 * restore (`restored` | `missing` | `skipped`). Returns null if the file is
 * absent (backups/restores predating this feature).
 * @param   {string}                                                                    dir  Backup directory.
 * @returns {Promise<{ database?: string, assets?: string, extensions?: string }|null>}      Per-component outcome, or null.
 */
export async function parseRestoreResult(dir) {
    let raw;
    try {
        raw = await readFile(join(dir, 'restore-result.txt'), 'utf8');
    } catch {
        return null;
    }
    /** @type {Record<string, string>} */
    const keyMap = { db: 'database', assets: 'assets', extensions: 'extensions' };
    /** @type {Record<string, string>} */
    const result = {};
    for (const line of raw.trim().split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) continue;
        const key = keyMap[line.slice(0, eqIdx).trim()];
        if (key) result[key] = line.slice(eqIdx + 1).trim();
    }
    return Object.keys(result).length > 0 ? result : null;
}

// ── Quota ─────────────────────────────────────────────────────

/**
 * Checks both storage quota limits defined in the backup config.
 * @returns {Promise<{ ok: boolean, reasons: Array<{ code: string, text: string, freeMB?: number, minFreeMB?: number, usedMB?: number, quotaMB?: number }>, usedMB: number|null, freeMB: number|null }>} Quota status with reasons and measured sizes.
 */
export async function checkQuota() {
    const cfg = await readConfig();
    const freeMB = getFreeMB();

    let usedMB = null;
    try {
        usedMB = Math.round(await dirSizeBytes(BACKUP_DIR) / (1024 * 1024));
    } catch (e) {
        console.warn('Backup size check failed:', /** @type {Error} */ (e).message);
    }

    const reasons = [];
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
 * @param   {number|null}                               freeMB     Free space in MB, or `null` if unknown (`df` failed).
 * @param   {number}                                    minFreeMB  Configured minimum free space in MB.
 * @returns {{ ok: boolean, budgetBytes: number|null }}            Upload decision and byte budget.
 */
export function uploadBudget(freeMB, minFreeMB) {
    if (freeMB === null) return { ok: true, budgetBytes: null };
    if (freeMB <= minFreeMB) return { ok: false, budgetBytes: 0 };
    return { ok: true, budgetBytes: (freeMB - minFreeMB) * 1024 * 1024 };
}

/**
 * Deletes the oldest scheduled backups one-by-one until the quota is satisfied.
 * @returns {Promise<boolean>} `true` if quota is now satisfied, `false` if not.
 */
export async function rotateForSpace() {
    const all = await readAllManifests();
    const candidates = all
        .filter(m => m.source === 'scheduled' && m.status === 'success')
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    for (const m of candidates) {
        const id = String(m.id);
        if (!BACKUP_ID_RE.test(id)) continue;
        const dir = join(BACKUP_DIR, id);
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
            console.warn(`Quota rotation: failed to delete ${id}:`, /** @type {Error} */ (e).message);
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

// ── Retention ─────────────────────────────────────────────────

/**
 * Enforces the configured retention policy by deleting old scheduled backups.
 * Manual backups are never auto-deleted.
 */
export async function enforceRetention() {
    const cfg = await readConfig();
    if (cfg.retention === 'all') return;

    const all = await readAllManifests();
    const scheduled = all
        .filter(m => m.source === 'scheduled' && m.status === 'success')
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    if (scheduled.length === 0) return;

    /** @type {Record<string, unknown>[]} */
    let toDelete = [];

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
        const dir = join(BACKUP_DIR, id);
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
            console.warn(`Retention: failed to delete ${id}:`, /** @type {Error} */ (e).message);
        } finally {
            await releaseLock(id);
        }
    }

    if (removed > 0) {
        console.log(`Retention: removed ${removed} old scheduled backup(s)`);
    }
}
