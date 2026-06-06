/**
 * Centralised configuration — all env-var reads happen here.
 * Every other module imports from this file; process.env is never
 * accessed anywhere else.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

/** HTTP port the sidecar listens on. */
export const PORT = 4700;
/** Shared secret required in every request to the sidecar (`X-Backup-Secret`). */
export const SECRET = process.env.BACKUP_SECRET;
/** Container path to backup storage. */
export const BACKUP_DIR = process.env.BACKUP_DIR || '/directus/backups';
/** Container path to Directus uploads. */
export const UPLOADS_DIR = process.env.UPLOADS_DIR || '/directus/uploads';
/** Container path to Directus extensions. */
export const EXTENSIONS_DIR = process.env.EXTENSIONS_DIR || '/directus/extensions';
/** Internal URL of the Directus instance. */
export const DIRECTUS_URL = process.env.DIRECTUS_URL || 'http://directus:8055';
/** Docker container name to stop/start during restore. */
export const DIRECTUS_CONTAINER = process.env.DIRECTUS_CONTAINER || 'directus';
/** Static Directus access token for version detection and failure notifications. */
export const BACKUP_TOKEN = process.env.BACKUP_TOKEN || '';
/** Admin email for backup failure notifications. User is looked up in Directus by email. */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
/** Database adapter name. Determines which shell adapter script is sourced by run.sh. */
export const DB_ADAPTER = process.env.DB_ADAPTER || process.env.DB_CLIENT || 'postgres';
/** Output format for pg_dump, either custom (compressed) or plain SQL. */
export const BACKUP_DUMP_FORMAT = process.env.BACKUP_DUMP_FORMAT === 'plain' ? 'plain' : 'custom';

/**
 * Parses a boolean operator flag. Secure-by-default: only the explicit strings
 * `'true'` and `'1'` enable the feature; everything else (including an unset
 * value) leaves it disabled.
 * @param   {string|undefined} v  Raw env-var value.
 * @returns {boolean}             `true` only for `'true'` or `'1'`.
 */
export function parseEnabledFlag(v) {
    return v === 'true' || v === '1';
}

/**
 * Whether importing (uploading) foreign backup archives is allowed. Operator-
 * controlled via `BACKUP_IMPORT_ENABLED`; secure-by-default OFF. Disabling this
 * removes the only ingress for attacker-supplied archive contents.
 */
export const IMPORT_ENABLED = parseEnabledFlag(process.env.BACKUP_IMPORT_ENABLED);

/**
 * Whether exporting (downloading) backup archives is allowed. Operator-
 * controlled via `BACKUP_EXPORT_ENABLED`; secure-by-default OFF. Disabling this
 * removes the bulk-exfiltration vector (full database + assets download).
 */
export const EXPORT_ENABLED = parseEnabledFlag(process.env.BACKUP_EXPORT_ENABLED);

/**
 * Maximum wall-clock time for a single `run.sh` execution (backup or restore)
 * before the runner process group is terminated. Guards against an indefinitely
 * hanging child such as a dump or restore blocked on a database lock wait, which
 * would otherwise hold the lock and block the sidecar forever. Configured via
 * `RUNNER_TIMEOUT_MIN` in minutes, where `0` disables the timeout. Defaults to
 * 90 minutes and should be raised for very large databases.
 * @type {number}
 */
export const RUNNER_TIMEOUT_MS = (() => {
    const n = parseInt(process.env.RUNNER_TIMEOUT_MIN ?? '90', 10);
    return Number.isFinite(n) && n >= 0 ? n * 60_000 : 90 * 60_000;
})();

export const DB_HOST = process.env.DB_HOST || 'database';
export const DB_USER = process.env.DB_USER || '';
export const DB_PASSWORD = process.env.DB_PASSWORD || '';
export const DB_DATABASE = process.env.DB_DATABASE || '';

/** Redis hostname for cache flush after restore. Set to empty (`CACHE_HOST=`) to disable the flush for setups without Redis. */
export const CACHE_HOST = process.env.CACHE_HOST === undefined ? 'cache' : process.env.CACHE_HOST;
/** Redis port for cache flush after restore. */
export const CACHE_PORT = parseInt(process.env.CACHE_PORT || '6379', 10);
/** Redis database index Directus uses. Only this DB is flushed after restore. */
export const CACHE_DB = (() => {
    const n = parseInt(process.env.CACHE_DB || '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
})();

// ── Event hooks ──────────────────────────────────────────────
// Naming convention: HOOK_<EVENT>_URL, HOOK_<EVENT>_SECRET
// Currently supported: POST_RESTORE

/** Webhook URL called after a successful restore (full URL incl. Path). */
export const HOOK_POST_RESTORE_URL = process.env.HOOK_POST_RESTORE_URL || '';
/** Auth secret sent as X-Webhook-Secret header. */
export const HOOK_POST_RESTORE_SECRET = process.env.HOOK_POST_RESTORE_SECRET || '';
/** Recovery hint shown in admin notifications on hook failure. */
export const HOOK_POST_RESTORE_HINT = process.env.HOOK_POST_RESTORE_HINT || '';

// ── Well-known filenames ──────────────────────────────────────

/**
 * Sentinel lock resource representing the single live system (database +
 * Directus container). Held by backup and restore, which mutate that shared
 * state and must never run concurrently, regardless of which backup ID is
 * involved. Per-backup-directory operations (restore source, download, delete)
 * lock their own backup ID instead.
 */
export const LIVE_DB = 'LIVE_DB';
export const MANIFEST_FILE = 'backup.json';
export const CONFIG_FILE = 'backup-config.json';

/** Directory under `BACKUP_DIR` that holds per-resource lock files (`<resource>.lock`). */
export const LOCKS_DIR_NAME = '.locks';

// ── Validation sets ───────────────────────────────────────────

/** Regex that every backup ID must satisfy. Prevents path traversal. */
export const BACKUP_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}__[0-9]{2}-[0-9]{2}-[0-9]{2}__[a-zA-Z0-9_-]+$/;
/**
 * Regex that every collection (table) name in a scope must satisfy. Scope names
 * flow into shell word lists and SQL identifiers (`pg_dump --table`,
 * `pg_restore --table`, and `DELETE FROM "<name>"` in the DB adapter). Restricting
 * them to a plain identifier charset at the trust boundary blocks SQL-identifier
 * breakout and shell metacharacter/glob abuse for every downstream sink at once.
 *
 * Allowed: ASCII letters (upper and lower case), digits, underscore, and hyphen.
 * This covers Directus's recommended lowercase snake_case convention, the
 * `directus_*` system tables, and mixed-case / hyphenated names. The hyphen is
 * safe here because the name is always emitted as a double-quoted SQL identifier
 * and `-` is neither an IFS (word-splitting) nor a shell glob character.
 * Deliberately excluded are quotes, semicolons, dots, whitespace, and glob
 * characters — the actual injection vectors. A name outside this set is rejected
 * for scoped operations; a full backup/restore is still possible.
 */
export const COLLECTION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Allowed values for the `schedule` config field. */
export const VALID_SCHEDULES = ['off', '1h', '6h', '12h', 'daily', '3d', 'weekly'];
/** Allowed values for the `retention` config field. */
export const VALID_RETENTIONS = ['all', 'last-3', 'last-5', 'last-10', 'days-7', 'days-30'];
/**
 * Default scope applied when no scope is configured.
 * `excludedCollections: []` means nothing is excluded (all tables are included).
 * An empty array always means "no filter" — never "nothing included".
 */
export const DEFAULT_SCOPE = { database: true, assets: true, extensions: false, excludedCollections: [] };

/** Default config applied when `backup-config.json` is missing or invalid. */
export const DEFAULT_CONFIG = {
    schedule: 'off',
    scheduleMinute: 0,
    scheduleHour: 0,
    retention: 'all',
    quotaMB: 0,
    minFreeMB: 100,
    backupScope: { ...DEFAULT_SCOPE }
};

/**
 * Builds a cron expression for the given schedule key and offset values.
 * Sub-daily schedules (1h, 6h, 12h) use `minute` to stagger execution across instances.
 * Daily+ schedules (daily, 3d, weekly) use `hour` instead.
 * @param   {string}      schedule  Schedule key, e.g. `daily` (see `VALID_SCHEDULES`).
 * @param   {number}      minute    0–59.
 * @param   {number}      hour      0–23.
 * @returns {string|null}           Cron expression, or null for 'off' / unknown schedules.
 */
export function buildCronExpr(schedule, minute, hour) {
    const m = Math.max(0, Math.min(59, Math.floor(minute)));
    const h = Math.max(0, Math.min(23, Math.floor(hour)));
    switch (schedule) {
        case '1h': return `${m} * * * *`;
        case '6h': return `${m} */6 * * *`;
        case '12h': return `${m} */12 * * *`;
        case 'daily': return `0 ${h} * * *`;
        case '3d': return `0 ${h} */3 * *`;
        case 'weekly': return `0 ${h} * * 0`;
        default: return null;
    }
}

// ── Startup guard ─────────────────────────────────────────────

if (!SECRET) {
    console.error('BACKUP_SECRET is required');
    process.exit(1);
}
