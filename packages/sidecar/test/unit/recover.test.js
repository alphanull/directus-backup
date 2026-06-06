import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { rm, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_DIR, LIVE_DB } from '../../lib/config.js';
import { acquireLock, readAllLocks, writeManifest, readManifest } from '../../lib/storage.js';
import { recoverStaleLocks, reconcileRunningManifests } from '../../lib/runner.js';

beforeEach(async () => {
	await rm(BACKUP_DIR, { recursive: true, force: true });
	await mkdir(BACKUP_DIR, { recursive: true });
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
		const dir = join(BACKUP_DIR, id);
		await writeManifest(dir, { id, status: 'running' });
		await acquireLock(LIVE_DB, { backupId: id, startedAt: '2026-01-02T00:00:00.000Z', source: 'manual', operation: 'backup' });

		await recoverStaleLocks();

		const m = await readManifest(dir);
		expect(m.status).toBe('failed');
		expect(String(m.error)).toMatch(/stale lock/i);
		expect(await readAllLocks()).toEqual([]);
	});

	it('finishes an interrupted delete by removing the directory and clearing the lock', async () => {
		const id = '2026-01-04__00-00-00__delete';
		const dir = join(BACKUP_DIR, id);
		await writeManifest(dir, { id, status: 'success' });
		await acquireLock(id, { backupId: id, startedAt: '2026-01-04T00:00:00.000Z', operation: 'delete' });

		await recoverStaleLocks();

		await expect(access(dir)).rejects.toBeTruthy();
		expect(await readAllLocks()).toEqual([]);
	});

	it('records an interrupted restore via restoreStatus, leaving the backup status untouched', async () => {
		const id = '2026-01-03__00-00-00__restore';
		const dir = join(BACKUP_DIR, id);
		// A restore runs against a successful backup; its own status stays 'success'.
		await writeManifest(dir, { id, status: 'success' });
		// A real restore holds both the LIVE_DB lock and the backup-ID lock.
		await acquireLock(LIVE_DB, { backupId: id, startedAt: '2026-01-03T00:00:00.000Z', operation: 'restore' });
		await acquireLock(id, { backupId: id, startedAt: '2026-01-03T00:00:00.000Z', operation: 'restore' });

		await recoverStaleLocks();

		const m = await readManifest(dir);
		expect(m.status).toBe('success');
		expect(m.restoreStatus).toBe('failed');
		expect(String(m.restoreError)).toMatch(/restart/i);
		expect(m.restoredAt).toBeTruthy();
		expect(await readAllLocks()).toEqual([]);
	});
});

describe('reconcileRunningManifests', () => {
	it('marks a manifest stuck at running (no lock) as failed', async () => {
		// The bug scenario: monitorProcess could not persist the terminal
		// manifest and its LIVE_DB lock was already released, so recoverStaleLocks
		// has nothing to act on.
		const id = '2026-01-05__00-00-00__backup';
		const dir = join(BACKUP_DIR, id);
		await writeManifest(dir, { id, status: 'running' });

		await reconcileRunningManifests();

		const m = await readManifest(dir);
		expect(m.status).toBe('failed');
		expect(m.finishedAt).toBeTruthy();
		expect(String(m.error)).toMatch(/restart/i);
	});

	it('leaves terminal manifests untouched', async () => {
		const okId = '2026-01-06__00-00-00__backup';
		const failId = '2026-01-07__00-00-00__backup';
		await writeManifest(join(BACKUP_DIR, okId), { id: okId, status: 'success' });
		await writeManifest(join(BACKUP_DIR, failId), { id: failId, status: 'failed', error: 'original' });

		await reconcileRunningManifests();

		expect((await readManifest(join(BACKUP_DIR, okId))).status).toBe('success');
		const failed = await readManifest(join(BACKUP_DIR, failId));
		expect(failed.status).toBe('failed');
		expect(failed.error).toBe('original');
	});

	it('preserves an existing error message on a running manifest', async () => {
		const id = '2026-01-08__00-00-00__backup';
		const dir = join(BACKUP_DIR, id);
		await writeManifest(dir, { id, status: 'running', error: 'partial write detail' });

		await reconcileRunningManifests();

		const m = await readManifest(dir);
		expect(m.status).toBe('failed');
		expect(m.error).toBe('partial write detail');
	});
});
