/**
 * startBackup must not leak the LIVE_DB lock when setup fails after the lock
 * was acquired — otherwise every later backup/restore is rejected with 409.
 * Ported from the sidecar suite.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { access, rm, mkdir, writeFile, mkdtemp } from 'node:fs/promises';

vi.mock('../../src/api/core/sanity.js', () => ({
    getSanityReport: async () => ({ operational: true, ok: true, restoreReady: true, issues: [], checkedAt: '' }),
    installationError: () => ''
}));
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initConfig, config, LIVE_DB } from '../../src/api/core/config.js';
import { acquireLock, readLock } from '../../src/api/storage/locks.js';
import { appendActivity, readActivity } from '../../src/api/core/activity.js';
import { writeManifest } from '../../src/api/storage/manifest.js';
import { monitorProcess, startBackup } from '../../src/api/backup/backup.js';
import { setRuntime } from '../../src/api/core/runtime.js';

const ID = '2026-01-05__00-00-00__manual';
let BACKUP_DIR: string;

const exists = async(path: string): Promise<boolean> => access(path).then(() => true).catch(() => false);

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 20; i++) {
        if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

beforeAll(async () => {
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'dbk-lock-'));
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

describe('startBackup lock release on setup failure', () => {
    it('releases the LIVE_DB lock when backupPath already exists as a file', async () => {
        // A file at backupPath is detected by the access() collision check before
        // writeManifest() is called. The lock must be released regardless.
        await writeFile(join(config.backupDir, ID), 'not a directory');

        const result = await startBackup(ID, 'manual');

        expect(result.ok).toBe(false);
        expect(await readLock(LIVE_DB)).toBeNull();
    });
});

describe('startBackup backup-ID collision detection', () => {
    it('returns 409 and releases the lock when the backup directory already exists', async () => {
        await mkdir(join(config.backupDir, ID), { recursive: true });

        const result = await startBackup(ID, 'manual');

        expect(result.ok).toBe(false);
        expect((result as { ok: false, status: number, error: string }).status).toBe(409);
        expect(await readLock(LIVE_DB)).toBeNull();
    });
});

describe('monitorProcess failed backup cleanup', () => {
    it('removes the partial backup directory after a runner failure', async () => {
        const id = '2026-01-06__00-00-00__manual';
        const dir = join(config.backupDir, id);
        await writeManifest(dir, { id, label: 'manual', status: 'running', source: 'manual' });
        await writeFile(join(dir, 'runner.log'), 'first line\nbackup exploded\n', 'utf8');
        await writeFile(join(dir, 'partial.dump'), 'partial data', 'utf8');
        await acquireLock(LIVE_DB, { backupId: id, startedAt: '2026-01-06T00:00:00.000Z', operation: 'backup' });

        monitorProcess(Promise.resolve({ exitCode: 2 }), id, 'manual');

        await waitFor(async() => await readLock(LIVE_DB) === null);

        expect(await exists(dir)).toBe(false);
        const entries = await readActivity(5);
        expect(entries.find(e => e.action === 'backup_failed' && e.backupId === id)?.detail).toContain('backup exploded');
    });
});
