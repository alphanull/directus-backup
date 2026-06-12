/**
 * Parsers for the verify artefacts written by the runner: backup checksums and
 * row counts, post-restore count verification, and per-component restore result.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

/** Parsed verify artefacts written by the runner after a successful backup. */
export interface VerifyData {
    checksums: Record<string, string>
    dumpTables?: number
    dbCounts: Record<string, number>
    collections?: string[]
}

/**
 * Parses the verify artefacts written by the runner after a successful backup.
 * Throws if either `checksums.sha256` or `db-counts.txt` is missing.
 * @param dir  Backup directory.
 * @returns    Parsed checksums, DB row counts, and the positive collection index.
 */
export async function parseVerifyData(dir: string): Promise<VerifyData> {
    const checksumRaw = await readFile(join(dir, 'checksums.sha256'), 'utf8');
    const countsRaw = await readFile(join(dir, 'db-counts.txt'), 'utf8');

    const checksums: Record<string, string> = {};
    for (const line of checksumRaw.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) checksums[parts[parts.length - 1]] = parts[0];
    }

    const dbCounts: Record<string, number> = {};
    let dumpTables: number | null = null;
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
    let collections: string[] | undefined;
    try {
        const tablesRaw = await readFile(join(dir, 'db-tables.txt'), 'utf8');
        collections = tablesRaw.split('\n').map(l => l.trim()).filter(Boolean);
    } catch { /* no db-tables.txt (legacy backup) */ }

    return { checksums, ...dumpTables === null ? {} : { dumpTables }, dbCounts, ...collections ? { collections } : {} };
}

/** Parsed restore-verification result. */
export interface RestoreVerify {
    status: 'ok' | 'warn'
    mismatches: number
    details?: Record<string, string>
}

/**
 * Parses `restore-verify.txt` written by the runner after a completed restore.
 * Throws if the file is absent (expected for backups predating the verify feature).
 * @param dir  Backup directory.
 * @returns    Parsed restore-verification result.
 */
export async function parseRestoreVerify(dir: string): Promise<RestoreVerify> {
    const raw = await readFile(join(dir, 'restore-verify.txt'), 'utf8');
    const result: Record<string, string> = {};
    for (const line of raw.trim().split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) continue;
        result[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
    }
    const mismatches = parseInt(result.mismatches || '0', 10);
    const details: Record<string, string> = {};
    for (const [k, v] of Object.entries(result)) {
        if (k.startsWith('mismatch.')) details[k.slice(9)] = v;
    }
    return {
        status: mismatches === 0 ? 'ok' : 'warn',
        mismatches,
        ...mismatches > 0 ? { details } : {}
    };
}

/** Per-component outcome of a restore. */
export interface RestoreResult {
    database?: string
    assets?: string
    extensions?: string
}

/**
 * Parses `restore-result.txt` written by the runner: per-component outcome of a
 * restore (`restored` | `missing` | `skipped`). Returns `null` if the file is
 * absent (backups/restores predating this feature).
 * @param dir  Backup directory.
 * @returns    Per-component outcome, or `null`.
 */
export async function parseRestoreResult(dir: string): Promise<RestoreResult | null> {
    let raw: string;
    try {
        raw = await readFile(join(dir, 'restore-result.txt'), 'utf8');
    } catch {
        return null;
    }
    const keyMap: Record<string, keyof RestoreResult> = { db: 'database', assets: 'assets', extensions: 'extensions' };
    const result: RestoreResult = {};
    for (const line of raw.trim().split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) continue;
        const key = keyMap[line.slice(0, eqIdx).trim()];
        if (key) result[key] = line.slice(eqIdx + 1).trim();
    }
    return Object.keys(result).length > 0 ? result : null;
}
