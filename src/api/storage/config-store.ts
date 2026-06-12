/**
 * Backup configuration persistence: read/validate/write `backup-config.json`.
 *
 * Stateless — paths are derived from {@link config} at call time, never at
 * import time.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { readFile, writeFile, rename } from 'node:fs/promises';
import {
    config,
    CONFIG_FILE,
    COLLECTION_NAME_RE,
    VALID_SCHEDULES,
    VALID_RETENTIONS,
    DEFAULT_CONFIG,
    DEFAULT_SCOPE
} from '../core/config.js';

/** Normalised global config scope (blocklist-based via `excludedCollections`). */
export interface NormalizedScope {
    database: boolean
    assets: boolean
    extensions: boolean
    excludedCollections: string[]
}

/** Validated backup configuration as persisted in `backup-config.json`. */
export interface BackupConfig {
    schedule: string
    scheduleMinute: number
    scheduleHour: number
    retention: string
    quotaMB: number
    minFreeMB: number
    backupScope: NormalizedScope
}

/**
 * Normalises a scope object, filling in defaults for missing/invalid fields.
 * The global config scope is blocklist-based (`excludedCollections`); a string
 * array is always returned so new collections are included by default.
 * @param raw  Raw scope value of any shape; non-objects yield all defaults.
 * @returns    Normalised scope with defaults filled in.
 */
function normalizeScope(raw: unknown): NormalizedScope {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        database: typeof s.database === 'boolean' ? s.database : DEFAULT_SCOPE.database,
        assets: typeof s.assets === 'boolean' ? s.assets : DEFAULT_SCOPE.assets,
        extensions: typeof s.extensions === 'boolean' ? s.extensions : DEFAULT_SCOPE.extensions,
        excludedCollections: Array.isArray(s.excludedCollections)
            ? (s.excludedCollections as unknown[]).filter((v): v is string => typeof v === 'string' && COLLECTION_NAME_RE.test(v))
            : []
    };
}

/**
 * Reads and validates `backup-config.json`. Falls back to {@link DEFAULT_CONFIG}
 * for any missing or invalid fields.
 * @returns The validated config, with defaults applied to missing/invalid fields.
 */
export async function readConfig(): Promise<BackupConfig> {
    try {
        const raw = await readFile(join(config.backupDir, CONFIG_FILE), 'utf8');
        const cfg = JSON.parse(raw);
        const toInt = (v: unknown, min: number, max: number, def: number): number => {
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
 * @param cfg  Config object to persist.
 */
export async function writeConfig(cfg: BackupConfig): Promise<void> {
    const target = join(config.backupDir, CONFIG_FILE);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    await rename(tmp, target);
}
