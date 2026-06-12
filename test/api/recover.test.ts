/**
 * Crash-recovery reconciliation: stale-lock cleanup on boot and the
 * second-pass sweep for manifests stuck at `running` without a lock.
 * Ported from the sidecar suite.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { rm, mkdir, access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initConfig, config, LIVE_DB, LOCKS_DIR_NAME, UPLOAD_TMP_PREFIX } from '../../src/api/core/config.js';
import { acquireLock, readAllLocks, readLock } from '../../src/api/storage/locks.js';
import { writeManifest, readManifest } from '../../src/api/storage/manifest.js';
import { recoverStaleLocks, reconcileRunningManifests, cleanStaleTmpFiles } from '../../src/api/recovery.js';
import { setRuntime } from '../../src/api/core/runtime.js';

let BACKUP_DIR: string;

beforeAll(async () => {
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'dbk-recover-'));
    initConfig({ BACKUP_DIR });
    setRuntime({
        getSchema: async () => ({}),
        services: {},
        database: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
});

beforeEach(async () => {
    await rm(config.backupDir, { recursive: true, force: true });
    await mkdir(config.backupDir, { recursive: true });
});

afterAll(async () => {
    await rm(BACKUP_DIR, { recursive: true, force: true });
});

describe('recoverStaleLocks', () => {
    it('is a no-op when no lock exists', async () => {
        await expect(recoverStaleLocks()).resolves.toBeUndefined();
        expect(await readAllLocks()).toEqual([]);
    });

    it('marks an interrupted backup (status running) as failed and clears the lock', async () => {
        const id = '2026-01-02__00-00-00__backup';
        const dir = join(config.backupDir, id);
        await writeManifest(dir, { id, status: 'running' });
        await acquireLock(LIVE_DB, { backupId: id, startedAt: '2026-01-02T00:00:00.000Z', source: 'manual', operation: 'backup' });

        await recoverStaleLocks();

        const m = await readManifest(dir);
        expect(m?.status).toBe('failed');
        expect(String(m?.error)).toMatch(/stale lock/i);
        expect(await readAllLocks()).toEqual([]);
    });

    it('finishes an interrupted delete by removing the directory and clearing the lock', async () => {
        const id = '2026-01-04__00-00-00__delete';
        const dir = join(config.backupDir, id);
        await writeManifest(dir, { id, status: 'success' });
        await acquireLock(id, { backupId: id, startedAt: '2026-01-04T00:00:00.000Z', operation: 'delete' });

        await recoverStaleLocks();

        await expect(access(dir)).rejects.toBeTruthy();
        expect(await readAllLocks()).toEqual([]);
    });

    it('records an interrupted restore via restoreStatus, leaving the backup status untouched', async () => {
        const id = '2026-01-03__00-00-00__restore';
        const dir = join(config.backupDir, id);
        await writeManifest(dir, { id, status: 'success' });
        await acquireLock(LIVE_DB, { backupId: id, startedAt: '2026-01-03T00:00:00.000Z', operation: 'restore' });
        await acquireLock(id, { backupId: id, startedAt: '2026-01-03T00:00:00.000Z', operation: 'restore' });

        await recoverStaleLocks();

        const m = await readManifest(dir);
        expect(m?.status).toBe('success');
        expect(m?.restoreStatus).toBe('failed');
        expect(String(m?.restoreError)).toMatch(/restart/i);
        expect(m?.restoredAt).toBeTruthy();
        expect(await readAllLocks()).toEqual([]);
    });

    it('cleans up a partial import directory and clears the lock', async () => {
        const id = '2026-01-10__00-00-00__import';
        const dir = join(config.backupDir, id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'database.dump'), 'partial content');
        await acquireLock(id, { backupId: id, startedAt: '2026-01-10T00:00:00.000Z', operation: 'import' });

        await recoverStaleLocks();

        await expect(access(dir)).rejects.toBeTruthy();
        expect(await readAllLocks()).toEqual([]);
    });

    it('clears a stale import lock even when no partial directory exists', async () => {
        const id = '2026-01-11__00-00-00__import';
        await acquireLock(id, { backupId: id, startedAt: '2026-01-11T00:00:00.000Z', operation: 'import' });

        await expect(recoverStaleLocks()).resolves.not.toThrow();

        expect(await readAllLocks()).toEqual([]);
    });

    it('releases a stale download lock without touching the backup directory', async () => {
        const id = '2026-01-12__00-00-00__download';
        const dir = join(config.backupDir, id);
        await writeManifest(dir, { id, status: 'success' });
        await acquireLock(id, { backupId: id, startedAt: '2026-01-12T00:00:00.000Z', operation: 'download' });

        await recoverStaleLocks();

        expect((await readManifest(dir))?.status).toBe('success');
        expect(await readAllLocks()).toEqual([]);
    });

    it('removes a corrupt LIVE_DB lock file so future operations are not blocked', async () => {
        const lockDir = join(config.backupDir, LOCKS_DIR_NAME);
        await mkdir(lockDir, { recursive: true });
        await writeFile(join(lockDir, `${LIVE_DB}.lock`), '{"resource":', 'utf8');

        expect(await readLock(LIVE_DB)).toBeNull();

        await recoverStaleLocks();

        expect(await readAllLocks()).toEqual([]);
        expect(await acquireLock(LIVE_DB, { backupId: '2026-01-09__00-00-00__backup', operation: 'backup' })).toBe(true);
    });
});

describe('cleanStaleTmpFiles', () => {
    it('removes stale upload temp files', async () => {
        const tmpName = `${UPLOAD_TMP_PREFIX}1749733696123.tar.gz`;
        await writeFile(join(config.backupDir, tmpName), 'garbage');

        await cleanStaleTmpFiles();

        await expect(access(join(config.backupDir, tmpName))).rejects.toBeTruthy();
    });

    it('leaves non-upload files untouched', async () => {
        const safeName = 'backup-config.json';
        await writeFile(join(config.backupDir, safeName), '{}');

        await cleanStaleTmpFiles();

        await expect(access(join(config.backupDir, safeName))).resolves.toBeUndefined();
    });

    it('is a no-op when no temp files exist', async () => {
        await expect(cleanStaleTmpFiles()).resolves.not.toThrow();
    });
});

describe('reconcileRunningManifests', () => {
    it('marks a manifest stuck at running (no lock) as failed', async () => {
        const id = '2026-01-05__00-00-00__backup';
        const dir = join(config.backupDir, id);
        await writeManifest(dir, { id, status: 'running' });

        await reconcileRunningManifests();

        const m = await readManifest(dir);
        expect(m?.status).toBe('failed');
        expect(m?.finishedAt).toBeTruthy();
        expect(String(m?.error)).toMatch(/restart/i);
    });

    it('leaves terminal manifests untouched', async () => {
        const okId = '2026-01-06__00-00-00__backup';
        const failId = '2026-01-07__00-00-00__backup';
        await writeManifest(join(config.backupDir, okId), { id: okId, status: 'success' });
        await writeManifest(join(config.backupDir, failId), { id: failId, status: 'failed', error: 'original' });

        await reconcileRunningManifests();

        expect((await readManifest(join(config.backupDir, okId)))?.status).toBe('success');
        const failed = await readManifest(join(config.backupDir, failId));
        expect(failed?.status).toBe('failed');
        expect(failed?.error).toBe('original');
    });

    it('preserves an existing error message on a running manifest', async () => {
        const id = '2026-01-08__00-00-00__backup';
        const dir = join(config.backupDir, id);
        await writeManifest(dir, { id, status: 'running', error: 'partial write detail' });

        await reconcileRunningManifests();

        const m = await readManifest(dir);
        expect(m?.status).toBe('failed');
        expect(m?.error).toBe('partial write detail');
    });
});
