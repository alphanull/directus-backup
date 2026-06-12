/**
 * scheduleContainerRestart must roll back both locks and the .pending_restore
 * flag when process.kill(1, 'SIGTERM') throws — otherwise backup/restore stays
 * permanently blocked inside the running process until a manual cleanup or a
 * later restart triggers finalizePendingRestore.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { rm, mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initConfig, config, LIVE_DB, restoreFlagPath } from '../../src/api/core/config.js';
import { acquireLock, readLock } from '../../src/api/storage/locks.js';
import { setRuntime } from '../../src/api/core/runtime.js';
import { readActivity } from '../../src/api/core/activity.js';
import { scheduleContainerRestart } from '../../src/api/restore/restore.js';

const ID = '2026-01-05__00-00-00__manual';

let BACKUP_DIR: string;

const flagExists = async (): Promise<boolean> => {
    try { await access(restoreFlagPath()); return true; } catch { return false; }
};

/** Acquires both restore locks and writes a minimal .pending_restore flag. */
async function armState(): Promise<void> {
    const now = new Date().toISOString();
    await acquireLock(LIVE_DB, { backupId: ID, startedAt: now, operation: 'restore' });
    await acquireLock(ID, { backupId: ID, startedAt: now, operation: 'restore' });
    await writeFile(restoreFlagPath(), `BACKUP_ID='${ID}'\n`, 'utf8');
}

beforeAll(async () => {
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'dbk-restart-rollback-'));
    initConfig({ BACKUP_DIR });
    setRuntime({
        getSchema: async () => ({}),
        services: {},
        database: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
});

afterAll(async () => {
    await rm(BACKUP_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
    await rm(config.backupDir, { recursive: true, force: true });
    await mkdir(config.backupDir, { recursive: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('scheduleContainerRestart – kill failure rollback', () => {
    it('releases the LIVE_DB lock when process.kill throws', async () => {
        await armState();
        vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }); });

        scheduleContainerRestart(ID, 0);
        await new Promise(r => setTimeout(r, 100));

        expect(await readLock(LIVE_DB)).toBeNull();
    });

    it('releases the per-backup lock when process.kill throws', async () => {
        await armState();
        vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }); });

        scheduleContainerRestart(ID, 0);
        await new Promise(r => setTimeout(r, 100));

        expect(await readLock(ID)).toBeNull();
    });

    it('deletes the .pending_restore flag when process.kill throws', async () => {
        await armState();
        vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }); });

        scheduleContainerRestart(ID, 0);
        await new Promise(r => setTimeout(r, 100));

        expect(await flagExists()).toBe(false);
    });

    it('writes a restore_failed activity entry when process.kill throws', async () => {
        await armState();
        vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }); });

        scheduleContainerRestart(ID, 0);
        await new Promise(r => setTimeout(r, 100));

        const entries = await readActivity(10);
        expect(entries.find(e => e.action === 'restore_failed' && e.backupId === ID)).toBeDefined();
    });

    it('does NOT roll back when process.kill succeeds (normal restart path)', async () => {
        await armState();
        // Suppress the real signal; process.kill returns true on success.
        vi.spyOn(process, 'kill').mockImplementation(() => true as unknown as never);

        scheduleContainerRestart(ID, 0);
        await new Promise(r => setTimeout(r, 100));

        // Locks and flag must remain — finalizePendingRestore handles them on the next boot.
        expect(await readLock(LIVE_DB)).not.toBeNull();
        expect(await readLock(ID)).not.toBeNull();
        expect(await flagExists()).toBe(true);
    });
});
