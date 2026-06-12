/**
 * Filesystem I/O: locks, config round-trips, manifests, retention, sizing,
 * quota budget, and verify/restore-result parsing.
 *
 * Ported from the sidecar suite. The standalone module derives its paths from
 * {@link config} at call time, so each run initialises a private temp directory
 * via {@link initConfig} instead of relying on a process-level `BACKUP_DIR`.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdir, writeFile, rm, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initConfig, config, LIVE_DB, CONFIG_FILE } from '../../src/api/core/config.js';
import { readConfig, writeConfig, type BackupConfig } from '../../src/api/storage/config-store.js';
import { acquireLock, readLock, readAllLocks, releaseLock } from '../../src/api/storage/locks.js';
import { writeManifest, readManifest, readAllManifests } from '../../src/api/storage/manifest.js';
import { dirSizeBytes, uploadBudget, enforceRetention } from '../../src/api/storage/space.js';
import { parseVerifyData, parseRestoreVerify, parseRestoreResult } from '../../src/api/storage/verify.js';

let BACKUP_DIR: string;

/** Casts a partial config for persistence; readConfig re-validates on the way out. */
const partialConfig = (p: Partial<BackupConfig>): BackupConfig => p as BackupConfig;

beforeAll(async () => {
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'dbk-storage-'));
    initConfig({ BACKUP_DIR });
});

beforeEach(async () => {
    await rm(config.backupDir, { recursive: true, force: true });
    await mkdir(config.backupDir, { recursive: true });
});

afterAll(async () => {
    await rm(BACKUP_DIR, { recursive: true, force: true });
});

describe('lock management', () => {
    const OTHER = '2026-01-01__00-00-00__other';

    it('acquires a lock and reads it back', async () => {
        const ok = await acquireLock(LIVE_DB, { id: 'test', op: 'backup' });
        expect(ok).toBe(true);
        const data = await readLock(LIVE_DB);
        expect(data).toMatchObject({ resource: LIVE_DB, id: 'test', op: 'backup' });
    });

    it('rejects a second acquisition of the same resource', async () => {
        await acquireLock(LIVE_DB, { id: 'first' });
        const second = await acquireLock(LIVE_DB, { id: 'second' });
        expect(second).toBe(false);
    });

    it('allows locking two different resources concurrently', async () => {
        expect(await acquireLock(LIVE_DB, { id: 'a' })).toBe(true);
        expect(await acquireLock(OTHER, { id: 'b' })).toBe(true);
        expect(await readAllLocks()).toHaveLength(2);
    });

    it('releases a lock so it can be re-acquired', async () => {
        await acquireLock(LIVE_DB, { id: 'temp' });
        await releaseLock(LIVE_DB);
        expect(await readLock(LIVE_DB)).toBeNull();
        expect(await acquireLock(LIVE_DB, { id: 'new' })).toBe(true);
    });

    it('releaseLock is safe when no lock exists', async () => {
        await expect(releaseLock(LIVE_DB)).resolves.not.toThrow();
    });

    it('readLock returns null when not locked', async () => {
        expect(await readLock(LIVE_DB)).toBeNull();
    });

    it('readAllLocks returns empty when nothing is locked', async () => {
        expect(await readAllLocks()).toEqual([]);
    });

    it('rejects an invalid lock resource', async () => {
        await expect(acquireLock('../evil', {})).rejects.toThrow();
    });
});

describe('readConfig / writeConfig', () => {
    it('returns defaults when config file is missing', async () => {
        const cfg = await readConfig();
        expect(cfg.schedule).toBe('off');
        expect(cfg.retention).toBe('all');
        expect(cfg.minFreeMB).toBe(100);
        expect(cfg.backupScope.database).toBe(true);
    });

    it('round-trips a config', async () => {
        await writeConfig(partialConfig({ schedule: 'daily', scheduleMinute: 0, scheduleHour: 3, retention: 'last-5', quotaMB: 500, minFreeMB: 200 }));
        const read = await readConfig();
        expect(read.schedule).toBe('daily');
        expect(read.retention).toBe('last-5');
        expect(read.quotaMB).toBe(500);
    });

    it('falls back to defaults for invalid values', async () => {
        const path = join(config.backupDir, CONFIG_FILE);
        await writeFile(path, '{"schedule":"bogus","retention":999}', 'utf8');
        const cfg = await readConfig();
        expect(cfg.schedule).toBe('off');
        expect(cfg.retention).toBe('all');
    });

    it('returns defaults on corrupted JSON', async () => {
        const path = join(config.backupDir, CONFIG_FILE);
        await writeFile(path, '{not valid}', 'utf8');
        const cfg = await readConfig();
        expect(cfg.schedule).toBe('off');
    });

    it('normalizes scope with defaults for missing fields', async () => {
        await writeFile(join(config.backupDir, CONFIG_FILE), JSON.stringify({ backupScope: { database: false } }));
        const cfg = await readConfig();
        expect(cfg.backupScope.database).toBe(false);
        expect(cfg.backupScope.assets).toBe(true);
        expect(cfg.backupScope.extensions).toBe(false);
        expect(cfg.backupScope.excludedCollections).toEqual([]);
    });

    it('persists excludedCollections through a config round-trip', async () => {
        await writeConfig(partialConfig({ backupScope: { database: true, assets: true, extensions: false, excludedCollections: ['analytics_events'] } }));
        const cfg = await readConfig();
        expect(cfg.backupScope.excludedCollections).toEqual(['analytics_events']);
    });
});

describe('writeManifest / readManifest', () => {
    it('writes and reads a manifest', async () => {
        const dir = join(config.backupDir, 'test-backup');
        const data = { id: 'test', status: 'success', createdAt: '2026-01-01T00:00:00Z' };
        await writeManifest(dir, data);
        const read = await readManifest(dir);
        expect(read).toMatchObject(data);
    });

    it('creates the directory if it does not exist', async () => {
        const dir = join(config.backupDir, 'nested', 'deep');
        await writeManifest(dir, { id: 'deep' });
        const s = await stat(dir);
        expect(s.isDirectory()).toBe(true);
    });

    it('returns null for non-existent directory', async () => {
        expect(await readManifest('/does/not/exist')).toBeNull();
    });
});

describe('readAllManifests', () => {
    it('returns manifests from valid backup directories', async () => {
        const id1 = '2026-01-01__00-00-00__first';
        const id2 = '2026-01-02__00-00-00__second';
        await writeManifest(join(config.backupDir, id1), { id: id1, status: 'success' });
        await writeManifest(join(config.backupDir, id2), { id: id2, status: 'success' });
        await mkdir(join(config.backupDir, '.hidden'), { recursive: true });

        const manifests = await readAllManifests();
        expect(manifests).toHaveLength(2);
        const ids = manifests.map(m => m.id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);
    });

    it('skips directories without manifest', async () => {
        const id = '2026-01-01__00-00-00__empty';
        await mkdir(join(config.backupDir, id), { recursive: true });
        const manifests = await readAllManifests();
        expect(manifests).toHaveLength(0);
    });
});

describe('enforceRetention', () => {
    const A = '2026-01-01__00-00-00__scheduled';
    const B = '2026-01-02__00-00-00__scheduled';
    const C = '2026-01-03__00-00-00__scheduled';
    const D = '2026-01-04__00-00-00__scheduled';
    const E = '2026-01-05__00-00-00__scheduled';

    const seedScheduled = (id: string, createdAt: string) =>
        writeManifest(join(config.backupDir, id), { id, source: 'scheduled', status: 'success', createdAt });

    const seedAll = async () => {
        await seedScheduled(A, '2026-01-01T00:00:00Z');
        await seedScheduled(B, '2026-01-02T00:00:00Z');
        await seedScheduled(C, '2026-01-03T00:00:00Z');
        await seedScheduled(D, '2026-01-04T00:00:00Z');
        await seedScheduled(E, '2026-01-05T00:00:00Z');
    };

    it('deletes old scheduled backups beyond the retention limit', async () => {
        await writeConfig(partialConfig({ retention: 'last-3' }));
        await seedAll();

        await enforceRetention();

        expect(await readManifest(join(config.backupDir, A))).toBeNull();
        expect(await readManifest(join(config.backupDir, B))).toBeNull();
        expect(await readManifest(join(config.backupDir, C))).not.toBeNull();
        expect(await readManifest(join(config.backupDir, D))).not.toBeNull();
        expect(await readManifest(join(config.backupDir, E))).not.toBeNull();
    });

    it('skips a backup whose per-backup lock is held (download/restore in progress)', async () => {
        await writeConfig(partialConfig({ retention: 'last-3' }));
        await seedAll();

        await acquireLock(A, { backupId: A, startedAt: new Date().toISOString(), operation: 'download' });

        await enforceRetention();

        expect(await readManifest(join(config.backupDir, A))).not.toBeNull();
        expect(await readManifest(join(config.backupDir, B))).toBeNull();
        expect(await readManifest(join(config.backupDir, C))).not.toBeNull();
        expect(await readLock(A)).not.toBeNull();
    });
});

describe('dirSizeBytes', () => {
    it('calculates total size of files in a directory', async () => {
        const dir = join(config.backupDir, 'size-test');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'a.txt'), 'hello');
        await writeFile(join(dir, 'b.txt'), 'world!');
        const size = await dirSizeBytes(dir);
        expect(size).toBe(11);
    });

    it('recurses into subdirectories', async () => {
        const dir = join(config.backupDir, 'nested-size');
        await mkdir(join(dir, 'sub'), { recursive: true });
        await writeFile(join(dir, 'a.txt'), 'abc');
        await writeFile(join(dir, 'sub', 'b.txt'), 'defgh');
        const size = await dirSizeBytes(dir);
        expect(size).toBe(8);
    });
});

describe('uploadBudget', () => {
    it('returns no guard when free space is unknown', () => {
        expect(uploadBudget(null, 100)).toEqual({ ok: true, budgetBytes: null });
    });

    it('rejects when free space is already below the margin', () => {
        expect(uploadBudget(50, 100)).toEqual({ ok: false, budgetBytes: 0 });
    });

    it('rejects when free space exactly equals the margin', () => {
        expect(uploadBudget(100, 100)).toEqual({ ok: false, budgetBytes: 0 });
    });

    it('allows the headroom above the margin (in bytes)', () => {
        expect(uploadBudget(150, 100)).toEqual({ ok: true, budgetBytes: 50 * 1024 * 1024 });
    });

    it('treats minFreeMB 0 as the full free space', () => {
        expect(uploadBudget(10, 0)).toEqual({ ok: true, budgetBytes: 10 * 1024 * 1024 });
    });
});

describe('parseVerifyData', () => {
    it('parses checksums and db counts', async () => {
        const dir = join(config.backupDir, 'verify-test');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'checksums.sha256'), 'abc123  database.dump\ndef456  uploads.tar.gz\n');
        await writeFile(join(dir, 'db-counts.txt'), '__dump_tables=29\ndirectus_users=5\ndirectus_roles=2\n');

        const result = await parseVerifyData(dir);
        expect(result.checksums['database.dump']).toBe('abc123');
        expect(result.checksums['uploads.tar.gz']).toBe('def456');
        expect(result.dumpTables).toBe(29);
        expect(result.dbCounts.directus_users).toBe(5);
        expect(result.dbCounts.directus_roles).toBe(2);
    });

    it('omits dumpTables when not present', async () => {
        const dir = join(config.backupDir, 'verify-no-tables');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'checksums.sha256'), 'abc  file.dump\n');
        await writeFile(join(dir, 'db-counts.txt'), 'directus_users=1\n');

        const result = await parseVerifyData(dir);
        expect(result).not.toHaveProperty('dumpTables');
    });

    it('parses the positive collection index from db-tables.txt', async () => {
        const dir = join(config.backupDir, 'verify-tables');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'checksums.sha256'), 'abc  database.dump\n');
        await writeFile(join(dir, 'db-counts.txt'), 'directus_users=1\n');
        await writeFile(join(dir, 'db-tables.txt'), 'articles\nauthors\ndirectus_users\n');

        const result = await parseVerifyData(dir);
        expect(result.collections).toEqual(['articles', 'authors', 'directus_users']);
    });

    it('omits collections when db-tables.txt is absent (legacy backup)', async () => {
        const dir = join(config.backupDir, 'verify-no-tables-file');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'checksums.sha256'), 'abc  database.dump\n');
        await writeFile(join(dir, 'db-counts.txt'), 'directus_users=1\n');

        const result = await parseVerifyData(dir);
        expect(result).not.toHaveProperty('collections');
    });
});

describe('parseRestoreVerify', () => {
    it('returns ok when no mismatches', async () => {
        const dir = join(config.backupDir, 'restore-ok');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'restore-verify.txt'), 'mismatches=0\n');

        const result = await parseRestoreVerify(dir);
        expect(result.status).toBe('ok');
        expect(result.mismatches).toBe(0);
        expect(result).not.toHaveProperty('details');
    });

    it('returns warn with details on mismatches', async () => {
        const dir = join(config.backupDir, 'restore-warn');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'restore-verify.txt'), 'mismatches=2\nmismatch.users=5!=3\nmismatch.roles=2!=1\n');

        const result = await parseRestoreVerify(dir);
        expect(result.status).toBe('warn');
        expect(result.mismatches).toBe(2);
        expect(result.details).toMatchObject({ users: '5!=3', roles: '2!=1' });
    });
});

describe('parseRestoreResult', () => {
    it('returns null when the file is absent', async () => {
        const dir = join(config.backupDir, 'restore-result-absent');
        await mkdir(dir, { recursive: true });
        expect(await parseRestoreResult(dir)).toBeNull();
    });

    it('maps the db key to database and reads all components', async () => {
        const dir = join(config.backupDir, 'restore-result-full');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'restore-result.txt'), 'db=restored\nassets=missing\nextensions=skipped\n');

        const result = await parseRestoreResult(dir);
        expect(result).toEqual({ database: 'restored', assets: 'missing', extensions: 'skipped' });
    });

    it('ignores unknown keys and blank lines', async () => {
        const dir = join(config.backupDir, 'restore-result-partial');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'restore-result.txt'), '\ndb=restored\nbogus=value\n');

        const result = await parseRestoreResult(dir);
        expect(result).toEqual({ database: 'restored' });
    });

    it('returns null when no known keys are present', async () => {
        const dir = join(config.backupDir, 'restore-result-empty');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'restore-result.txt'), 'bogus=value\n');

        expect(await parseRestoreResult(dir)).toBeNull();
    });
});
