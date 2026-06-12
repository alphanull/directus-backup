/**
 * Centralised configuration for the standalone backup extension.
 *
 * Unlike the sidecar (which reads `process.env` at import time), the extension
 * runs inside Directus and receives its environment via the endpoint
 * `context.env`. Whether Directus mirrors the parsed `.env` into `process.env`
 * for extensions is not guaranteed, so all environment-derived values are
 * initialised explicitly through {@link initConfig}, which the endpoint handler
 * calls exactly once before any route runs.
 *
 * Environment-independent values (regexes, validation sets, filenames,
 * defaults) remain plain module-level constants.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';

// Re-exported from the shared contract so the rest of the backend keeps a single
// import site for the backup-ID pattern.
export { BACKUP_ID_RE } from '../../shared/constants.js';

/** Directus policy name that grants access to the Backup module UI + API (server-side lookup only). */
export const BACKUP_POLICY_NAME = 'Backup Access';

// ── Well-known filenames ──────────────────────────────────────

/**
 * Sentinel lock resource representing the single live system (database +
 * Directus). Held by backup and restore, which mutate that shared state and
 * must never run concurrently, regardless of which backup ID is involved.
 * Per-backup-directory operations (restore source, download, delete) lock their
 * own backup ID instead.
 */
export const LIVE_DB = 'LIVE_DB';
export const MANIFEST_FILE = 'backup.json';
export const CONFIG_FILE = 'backup-config.json';

/** Directory under `BACKUP_DIR` that holds per-resource lock files (`<resource>.lock`). */
export const LOCKS_DIR_NAME = '.locks';

/** Prefix for upload temp files written during import streaming (`.upload-<timestamp>.tar.gz`). */
export const UPLOAD_TMP_PREFIX = '.upload-';

/**
 * Restore handshake files, all written under `BACKUP_DIR` so they survive the
 * container restart that drives the restore. The lifecycle is:
 *
 * 1. The extension writes {@link RESTORE_FLAG_NAME} (sh-friendly `KEY=VALUE`
 * runner env) and triggers a container restart.
 * 2. `restore.sh` claims it by renaming to {@link RESTORE_PROCESSING_NAME} (so a
 * crash mid-restore cannot loop), runs the restore, then renames to
 * {@link RESTORE_DONE_NAME} (success) or {@link RESTORE_FAILED_NAME} (failure).
 * 3. On the next Directus boot the extension reconciles the manifest from the
 * marker + artefacts, then deletes the marker.
 *
 * A `.restore_processing` file still present at boot means the entrypoint
 * crashed mid-restore: the outcome is unknown and it is reconciled as failed
 * without re-running (loop guard).
 */
export const RESTORE_FLAG_NAME = '.pending_restore';
export const RESTORE_PROCESSING_NAME = '.restore_processing';
export const RESTORE_DONE_NAME = '.restore_done';
export const RESTORE_FAILED_NAME = '.restore_failed';

// ── Validation sets ───────────────────────────────────────────

/**
 * Regex that every collection (table) name in a scope must satisfy. Scope names
 * flow into shell word lists and SQL identifiers (`pg_dump --table`,
 * `pg_restore --table`, and `DELETE FROM "<name>"` in the DB adapter). Restricting
 * them to a plain identifier charset at the trust boundary blocks SQL-identifier
 * breakout and shell metacharacter/glob abuse for every downstream sink at once.
 *
 * Allowed: ASCII letters (upper and lower case), digits, underscore, and hyphen.
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
export const DEFAULT_SCOPE = { database: true, assets: true, extensions: false, excludedCollections: [] as string[] };

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

// ── Pure helpers ──────────────────────────────────────────────

/**
 * Parses a boolean operator flag. Secure-by-default: only the explicit strings
 * `'true'` and `'1'` (or a real boolean `true`) enable the feature; everything
 * else (including an unset value) leaves it disabled.
 * @param v  Raw env value (Directus may pass a string or a coerced boolean).
 * @returns  `true` only for `true`, `'true'`, or `'1'`.
 */
export function parseEnabledFlag(v: unknown): boolean {
    return v === true || v === 'true' || v === '1';
}

/**
 * Builds a cron expression for the given schedule key and offset values.
 * Sub-daily schedules (1h, 6h, 12h) use `minute` to stagger execution.
 * Daily+ schedules (daily, 3d, weekly) use `hour` instead.
 * @param schedule  Schedule key, e.g. `daily` (see {@link VALID_SCHEDULES}).
 * @param minute    0–59.
 * @param hour      0–23.
 * @returns         Cron expression, or `null` for `off` / unknown schedules.
 */
export function buildCronExpr(schedule: string, minute: number, hour: number): string | null {
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

// ── Environment-derived runtime config ────────────────────────

/** Shape of the environment-derived configuration singleton. */
export interface RuntimeConfig {
    /** Container path to backup storage. */
    backupDir: string
    /** Container path to Directus uploads. */
    uploadsDir: string
    /** Container path to Directus extensions. */
    extensionsDir: string
    /** Database adapter name; selects the shell adapter sourced by the runner scripts. */
    dbAdapter: string
    /** Whether importing (uploading) foreign backup archives is allowed. */
    importEnabled: boolean
    /** Whether exporting (downloading) backup archives is allowed. */
    exportEnabled: boolean
    /** Max wall-clock time for a single `backup.sh` execution in ms; `0` disables. */
    runnerTimeoutMs: number
    /** Admin email used to target backup notifications (looked up in Directus). */
    adminEmail: string
    db: { host: string, port: number, user: string, password: string, database: string }
    cache: { host: string, port: number, db: number }
    hooks: { postRestore: { url: string, secret: string, hint: string } }
}

/**
 * Runtime configuration singleton. Populated once by {@link initConfig}; all
 * other modules import this object and read its fields at call time (never at
 * import time), so the values are always the initialised ones.
 *
 * The defaults below mirror the sidecar and apply only if {@link initConfig} has
 * not run yet — which never happens in normal operation.
 */
export const config: RuntimeConfig = {
    backupDir: '/directus/backups',
    uploadsDir: '/directus/uploads',
    extensionsDir: '/directus/extensions',
    dbAdapter: 'postgres',
    importEnabled: false,
    exportEnabled: false,
    runnerTimeoutMs: 90 * 60_000,
    adminEmail: '',
    db: { host: 'database', port: 5432, user: '', password: '', database: '' },
    cache: { host: 'cache', port: 6379, db: 0 },
    hooks: { postRestore: { url: '', secret: '', hint: '' } }
};

/** Reads a single env value as a trimmed string, with a fallback default. */
function envStr(env: Record<string, unknown>, key: string, def = ''): string {
    const v = env[key];
    return v === undefined || v === null ? def : String(v);
}

/**
 * Maps a Directus `DB_CLIENT` value to the matching shell adapter name. Directus
 * uses `pg` for PostgreSQL, but the adapter script is `adapters/postgres.sh`, so
 * the standard Directus environment works without an explicit `DB_ADAPTER`.
 * @param name  Raw adapter/client name.
 * @returns     The shell adapter name.
 */
function normalizeAdapter(name: string): string {
    return name === 'pg' ? 'postgres' : name;
}

/** Reads a single env value as a non-negative integer, with a fallback default. */
function envInt(env: Record<string, unknown>, key: string, def: number): number {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === '') return def;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : def;
}

/**
 * Initialises {@link config} from the Directus endpoint environment. Must be
 * called once at endpoint startup before any route or scheduler runs.
 *
 * `CACHE_HOST` keeps the sidecar semantics: an explicitly empty value
 * (`CACHE_HOST=`) disables the post-restore Redis flush; an unset value defaults
 * to `cache`.
 * @param env  The `context.env` record provided by the Directus endpoint.
 */
export function initConfig(env: Record<string, unknown>): void {
    config.backupDir = envStr(env, 'BACKUP_DIR', '/directus/backups');
    config.uploadsDir = envStr(env, 'UPLOADS_DIR', '/directus/uploads');
    config.extensionsDir = envStr(env, 'EXTENSIONS_DIR', '/directus/extensions');
    config.dbAdapter = normalizeAdapter(envStr(env, 'DB_ADAPTER') || envStr(env, 'DB_CLIENT') || 'postgres');
    config.importEnabled = parseEnabledFlag(env.BACKUP_IMPORT_ENABLED);
    config.exportEnabled = parseEnabledFlag(env.BACKUP_EXPORT_ENABLED);

    const timeoutMin = envInt(env, 'RUNNER_TIMEOUT_MIN', 90);
    config.runnerTimeoutMs = timeoutMin * 60_000;

    config.adminEmail = envStr(env, 'ADMIN_EMAIL');

    config.db = {
        host: envStr(env, 'DB_HOST', 'database'),
        port: envInt(env, 'DB_PORT', 5432),
        user: envStr(env, 'DB_USER'),
        password: envStr(env, 'DB_PASSWORD'),
        database: envStr(env, 'DB_DATABASE')
    };

    // CACHE_HOST: explicit empty string disables the flush; unset defaults to 'cache'.
    const cacheHost = env.CACHE_HOST === undefined ? 'cache' : String(env.CACHE_HOST);
    config.cache = {
        host: cacheHost,
        port: envInt(env, 'CACHE_PORT', 6379),
        db: envInt(env, 'CACHE_DB', 0)
    };

    config.hooks = {
        postRestore: {
            url: envStr(env, 'HOOK_POST_RESTORE_URL'),
            secret: envStr(env, 'HOOK_POST_RESTORE_SECRET'),
            hint: envStr(env, 'HOOK_POST_RESTORE_HINT')
        }
    };
}

/** Absolute path to the pending-restore flag file on the backup volume. */
export function restoreFlagPath(): string {
    return join(config.backupDir, RESTORE_FLAG_NAME);
}

/** Absolute path to a restore handshake file by its name constant. */
export function restoreMarkerPath(name: string): string {
    return join(config.backupDir, name);
}
