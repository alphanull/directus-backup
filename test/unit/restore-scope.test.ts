/**
 * Unit tests for requestRestore() scope validation against the dump's positive
 * collection index (scope.collections).
 *
 * The collections check runs before getSanityReport() so these tests do not
 * require a fully installed environment (no pg_restore, no entrypoint, etc.).
 * A 503 from the sanity check means the collections check passed; 422 means it
 * rejected the unknown collection before reaching the sanity check.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initConfig } from '../../src/api/core/config.js';
import { requestRestore } from '../../src/api/restore/restore.js';

const ID = '2026-01-05__00-00-00__manual';

let BACKUP_DIR: string;
let backupPath: string;

beforeAll(async () => {
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'dbk-restore-scope-'));
    backupPath = join(BACKUP_DIR, ID);
    initConfig({ BACKUP_DIR });
});

afterAll(async () => {
    await rm(BACKUP_DIR, { recursive: true, force: true });
});

/** Writes a minimal success manifest with the given scope into backupPath. */
async function seedManifest(scope: Record<string, unknown>): Promise<Record<string, unknown>> {
    await mkdir(backupPath, { recursive: true });
    const manifest = { id: ID, status: 'success', scope };
    await writeFile(join(backupPath, 'backup.json'), JSON.stringify(manifest));
    return manifest;
}

describe('requestRestore – targeted restore against scope.collections', () => {
    it('rejects with 422 when a requested collection is absent from scope.collections', async () => {
        const manifest = await seedManifest({
            database: true, assets: false, extensions: false,
            collections: ['table_a', 'table_b']
        });

        const result = await requestRestore(ID, manifest, backupPath, {
            database: true, assets: false, extensions: false,
            includeCollections: ['table_a', 'missing_table']
        });

        expect(result.ok).toBe(false);
        expect((result as { status: number }).status).toBe(422);
        expect((result as { error: string }).error).toMatch(/missing_table/);
    });

    it('lists every unknown collection in the error message', async () => {
        const manifest = await seedManifest({
            database: true, collections: ['table_a']
        });

        const result = await requestRestore(ID, manifest, backupPath, {
            database: true, assets: false, extensions: false,
            includeCollections: ['table_a', 'ghost_1', 'ghost_2']
        });

        expect(result.ok).toBe(false);
        expect((result as { status: number }).status).toBe(422);
        expect((result as { error: string }).error).toMatch(/ghost_1/);
        expect((result as { error: string }).error).toMatch(/ghost_2/);
    });

    it('does not reject when all requested collections are present in scope.collections', async () => {
        const manifest = await seedManifest({
            database: true, assets: false, extensions: false,
            collections: ['table_a', 'table_b', 'table_c']
        });

        const result = await requestRestore(ID, manifest, backupPath, {
            database: true, assets: false, extensions: false,
            includeCollections: ['table_a', 'table_b']
        });

        // Collections check passes; the sanity check blocks with 503 in a test
        // environment (no pg_restore binary, no entrypoint) — not 422.
        expect((result as { status: number }).status).not.toBe(422);
    });

    it('does not reject when scope.collections is absent (legacy backup)', async () => {
        const manifest = await seedManifest({
            database: true
            // no collections field
        });

        const result = await requestRestore(ID, manifest, backupPath, {
            database: true, assets: false, extensions: false,
            includeCollections: ['any_table']
        });

        // No positive index → skip check; sanity blocks with 503.
        expect((result as { status: number }).status).not.toBe(422);
    });

    it('does not reject when no collections are requested (full restore)', async () => {
        const manifest = await seedManifest({
            database: true, collections: ['table_a', 'table_b']
        });

        const result = await requestRestore(ID, manifest, backupPath, {
            database: true, assets: false, extensions: false,
            includeCollections: []
        });

        // includeCollections empty → targeted restore not requested; sanity blocks with 503.
        expect((result as { status: number }).status).not.toBe(422);
    });

    it('does not reject when database is not included in the restore scope', async () => {
        const manifest = await seedManifest({
            database: false, assets: true, extensions: false,
            collections: []  // no tables in dump (DB not backed up)
        });

        const result = await requestRestore(ID, manifest, backupPath, {
            database: false, assets: true, extensions: false,
            includeCollections: ['would_be_absent']
        });

        // database=false in resolved scope → collections check skipped; sanity blocks with 503.
        expect((result as { status: number }).status).not.toBe(422);
    });
});
