/**
 * Request-input validation and backup-ID generation: traversal-safe ID checks,
 * scope-payload validation, and the timestamped ID format.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { resolve as resolvePath } from 'node:path';
import type { Response } from 'express';
import { config, BACKUP_ID_RE, COLLECTION_NAME_RE } from '../core/config.js';

/** Zero-pads a number to two digits. */
export function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** Generates a timestamped backup ID: `YYYY-MM-DD__HH-MM-SS__<label>`. */
export function generateBackupId(label: string): string {
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `${date}__${time}__${label}`;
}

/** Validates a backup ID and its resolved path (traversal-safe). Sends 400 on failure. */
export function validateBackupId(backupId: string | undefined, res: Response): backupId is string {
    if (!backupId || !BACKUP_ID_RE.test(backupId)) {
        res.status(400).json({ error: 'Invalid backupId' });
        return false;
    }
    const backupPath = resolvePath(config.backupDir, backupId);
    if (!backupPath.startsWith(`${resolvePath(config.backupDir)}/`)) {
        res.status(400).json({ error: 'Invalid backupId' });
        return false;
    }
    return true;
}

/** Provided scope fields after validation; only present fields are set. */
export type ScopeFields = Partial<{ database: boolean, assets: boolean, extensions: boolean, includeCollections: string[], excludedCollections: string[] }>;

/** Validates a raw scope object; only provided fields are type-checked and returned. */
export function validateScopeInput(input: unknown): { ok: true, value: ScopeFields } | { ok: false, error: string } {
    if (!input || typeof input !== 'object') return { ok: false, error: 'scope must be an object' };
    const s = input as Record<string, unknown>;
    const out: ScopeFields = {};
    if (s.database !== undefined) {
        if (typeof s.database !== 'boolean') return { ok: false, error: 'scope.database must be a boolean' };
        out.database = s.database;
    }
    if (s.assets !== undefined) {
        if (typeof s.assets !== 'boolean') return { ok: false, error: 'scope.assets must be a boolean' };
        out.assets = s.assets;
    }
    if (s.extensions !== undefined) {
        if (typeof s.extensions !== 'boolean') return { ok: false, error: 'scope.extensions must be a boolean' };
        out.extensions = s.extensions;
    }
    if (s.includeCollections !== undefined) {
        if (!Array.isArray(s.includeCollections) || (s.includeCollections as unknown[]).some(v => typeof v !== 'string')) {
            return { ok: false, error: 'scope.includeCollections must be an array of strings' };
        }
        if ((s.includeCollections as string[]).some(v => !COLLECTION_NAME_RE.test(v))) {
            return { ok: false, error: 'scope.includeCollections contains an invalid collection name' };
        }
        out.includeCollections = s.includeCollections as string[];
    }
    if (s.excludedCollections !== undefined) {
        if (!Array.isArray(s.excludedCollections) || (s.excludedCollections as unknown[]).some(v => typeof v !== 'string')) {
            return { ok: false, error: 'scope.excludedCollections must be an array of strings' };
        }
        if ((s.excludedCollections as string[]).some(v => !COLLECTION_NAME_RE.test(v))) {
            return { ok: false, error: 'scope.excludedCollections contains an invalid collection name' };
        }
        out.excludedCollections = s.excludedCollections as string[];
    }
    return { ok: true, value: out };
}

/** True if a scope would produce an empty backup (no component selected). */
export function isEmptyComponentScope(scope: { database?: boolean, assets?: boolean, extensions?: boolean }): boolean {
    return !scope.database && !scope.assets && !scope.extensions;
}
