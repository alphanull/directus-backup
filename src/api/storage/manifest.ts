/**
 * Backup manifest (`backup.json`) read/write helpers.
 *
 * Stateless — paths are derived from {@link config} at call time.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { join } from 'node:path';
import { readFile, readdir, writeFile, rename, mkdir } from 'node:fs/promises';
import { config, MANIFEST_FILE, BACKUP_ID_RE } from '../core/config.js';
import type { BackupManifest } from '../../shared/types.js';

/**
 * Read-boundary type: manifests are loosely typed when read, because the
 * directory may hold legacy, partial, or imported (foreign) manifests. Callers
 * read known fields defensively. Construction sites use the strict
 * {@link BackupManifest} contract instead.
 */
export type Manifest = Record<string, unknown>;

/**
 * Atomically writes a manifest (`backup.json`) into the given directory.
 * Creates the directory if it does not exist.
 * @param dir   Absolute path to the backup directory.
 * @param data  Manifest contents to serialise.
 */
export async function writeManifest(dir: string, data: BackupManifest | Manifest): Promise<void> {
    await mkdir(dir, { recursive: true });
    const target = join(dir, MANIFEST_FILE);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, target);
}

/**
 * Reads and parses the manifest from a backup directory.
 * @param dir  Absolute path to the backup directory.
 * @returns    Parsed manifest, or `null` on any error.
 */
export async function readManifest(dir: string): Promise<Manifest | null> {
    try {
        return JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Reads all valid backup manifests from the backup root directory.
 * Silently skips entries that are not valid backup ID directories or lack a manifest.
 * @returns All valid backup manifests found in the backup root.
 */
export async function readAllManifests(): Promise<Manifest[]> {
    try {
        const entries = await readdir(config.backupDir, { withFileTypes: true });
        const manifests: Manifest[] = [];
        for (const e of entries) {
            if (!e.isDirectory() || !BACKUP_ID_RE.test(e.name)) continue;
            const m = await readManifest(join(config.backupDir, e.name));
            if (m) manifests.push(m);
        }
        return manifests;
    } catch {
        return [];
    }
}
