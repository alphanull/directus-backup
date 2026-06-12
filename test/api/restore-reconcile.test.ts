/**
 * Direct tests for boot-time restore marker reconciliation.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    config,
    initConfig,
    LIVE_DB,
    RESTORE_DONE_NAME,
    RESTORE_FAILED_NAME,
    RESTORE_FLAG_NAME,
    RESTORE_PROCESSING_NAME,
    restoreMarkerPath
} from '../../src/api/core/config.js';
import { setRuntime } from '../../src/api/core/runtime.js';
import { readActivity } from '../../src/api/core/activity.js';
import { acquireLock, readLock } from '../../src/api/storage/locks.js';
import { readManifest, writeManifest } from '../../src/api/storage/manifest.js';
import { finalizePendingRestore } from '../../src/api/restore/reconcile.js';
import type { ActivityEntry } from '../../src/shared/types.js';

const ID = '2026-01-09__00-00-00__restore';

let BACKUP_DIR: string;

/** Returns the test backup directory path. */
function backupPath(): string {
    return join(config.backupDir, ID);
}

/** Writes a restore marker for the shared test backup ID. */
async function writeMarker(name: string): Promise<void> {
    await writeFile(restoreMarkerPath(name), `BACKUP_ID='${ID}'\n`, 'utf8');
}

/** Checks whether a restore marker still exists. */
async function markerExists(name: string): Promise<boolean> {
    try {
        await access(restoreMarkerPath(name));
        return true;
    } catch {
        return false;
    }
}

/** Creates the manifest and locks that exist while a restore is armed. */
async function createArmedRestore(): Promise<void> {
    const now = '2026-01-09T00:00:00.000Z';
    await writeManifest(backupPath(), { id: ID, status: 'success' });
    await acquireLock(LIVE_DB, { backupId: ID, startedAt: now, operation: 'restore' });
    await acquireLock(ID, { backupId: ID, startedAt: now, operation: 'restore' });
}

/** Waits for best-effort activity writes started by reconcileRestoreOutcome. */
async function waitForActivity(action: string): Promise<ActivityEntry | undefined> {
    for (let i = 0; i < 20; i++) {
        const entry = (await readActivity(10)).find(e => e.action === action && e.backupId === ID);
        if (entry) return entry;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return undefined;
}

beforeAll(async() => {
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'dbk-restore-reconcile-'));
    setRuntime({
        getSchema: async() => ({}),
        services: {},
        database: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
});

beforeEach(async() => {
    initConfig({ BACKUP_DIR });
    await rm(config.backupDir, { recursive: true, force: true });
    await mkdir(config.backupDir, { recursive: true });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

afterAll(async() => {
    await rm(BACKUP_DIR, { recursive: true, force: true });
});

describe('finalizePendingRestore', () => {
    it('reconciles .restore_done as success, releases locks, removes marker, and fires the hook', async() => {
        initConfig({ BACKUP_DIR, HOOK_POST_RESTORE_URL: 'https://example.test/hook', HOOK_POST_RESTORE_SECRET: 'secret' });
        const fetchMock = vi.fn(async(input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/server/health')) return { ok: true } as Response;
            return { ok: true, text: async() => '' } as Response;
        });
        vi.stubGlobal('fetch', fetchMock);
        await createArmedRestore();
        await writeFile(join(backupPath(), 'restore-result.txt'), 'db=restored\nassets=skipped\nextensions=missing\n', 'utf8');
        await writeFile(join(backupPath(), 'restore-verify.txt'), 'mismatches=1\nmismatch.directus_users=2->3\n', 'utf8');
        await writeMarker(RESTORE_DONE_NAME);

        await finalizePendingRestore();

        const manifest = await readManifest(backupPath());
        expect(manifest?.restoreStatus).toBe('success');
        expect(manifest?.restoreError).toBeUndefined();
        expect(manifest?.restore).toEqual({ database: 'restored', assets: 'skipped', extensions: 'missing' });
        expect(manifest?.restoreVerify).toEqual({
            status: 'warn',
            mismatches: 1,
            details: { directus_users: '2->3' }
        });
        expect(await readLock(LIVE_DB)).toBeNull();
        expect(await readLock(ID)).toBeNull();
        expect(await markerExists(RESTORE_DONE_NAME)).toBe(false);
        expect(await waitForActivity('restore_success')).toBeDefined();
        expect(fetchMock).toHaveBeenCalledWith('https://example.test/hook', expect.objectContaining({
            method: 'POST',
            headers: { 'X-Webhook-Secret': 'secret' }
        }));
    });

    it('reconciles .restore_failed as failed with the runner error', async() => {
        await createArmedRestore();
        await writeFile(join(backupPath(), 'restore-error.txt'), 'pg_restore failed\n', 'utf8');
        await writeMarker(RESTORE_FAILED_NAME);

        await finalizePendingRestore();

        const manifest = await readManifest(backupPath());
        expect(manifest?.restoreStatus).toBe('failed');
        expect(manifest?.restoreError).toBe('pg_restore failed');
        expect(await readLock(LIVE_DB)).toBeNull();
        expect(await readLock(ID)).toBeNull();
        expect(await markerExists(RESTORE_FAILED_NAME)).toBe(false);
        expect(await waitForActivity('restore_failed')).toMatchObject({ detail: 'pg_restore failed' });
    });

    it('reconciles .restore_processing as a crashed restore without rerunning it', async() => {
        await createArmedRestore();
        await writeMarker(RESTORE_PROCESSING_NAME);

        await finalizePendingRestore();

        const manifest = await readManifest(backupPath());
        expect(manifest?.restoreStatus).toBe('failed');
        expect(String(manifest?.restoreError)).toMatch(/interrupted before it finished/i);
        expect(String(manifest?.restoreError)).toMatch(/partially restored/i);
        expect(await readLock(LIVE_DB)).toBeNull();
        expect(await readLock(ID)).toBeNull();
        expect(await markerExists(RESTORE_PROCESSING_NAME)).toBe(false);
        expect(await waitForActivity('restore_failed')).toBeDefined();
    });

    it('reconciles stale .pending_restore as an unfired restore and keeps the DB status untouched', async() => {
        await createArmedRestore();
        await writeMarker(RESTORE_FLAG_NAME);

        await finalizePendingRestore();

        const manifest = await readManifest(backupPath());
        expect(manifest?.status).toBe('success');
        expect(manifest?.restoreStatus).toBe('failed');
        expect(String(manifest?.restoreError)).toMatch(/did not run/i);
        expect(String(manifest?.restoreError)).toMatch(/database was not modified/i);
        expect(await readLock(LIVE_DB)).toBeNull();
        expect(await readLock(ID)).toBeNull();
        expect(await markerExists(RESTORE_FLAG_NAME)).toBe(false);
        expect(await waitForActivity('restore_failed')).toBeDefined();
    });
});
