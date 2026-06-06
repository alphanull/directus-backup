import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_DIR, LIVE_DB } from '../../lib/config.js';
import { readLock } from '../../lib/storage.js';
import { startBackup } from '../../lib/runner.js';

const ID = '2026-01-05__00-00-00__manual';

beforeEach(async () => {
	// Removing the whole dir also clears any leftover lock file.
	await rm(BACKUP_DIR, { recursive: true, force: true });
	await mkdir(BACKUP_DIR, { recursive: true });
});

afterAll(async () => {
	await rm(BACKUP_DIR, { recursive: true, force: true });
});

describe('startBackup lock release on setup failure', () => {
	it('releases the LIVE_DB lock when the initial manifest write fails after acquiring the lock', async () => {
		// Plant a regular file where the backup directory must be created. The
		// first writeManifest() call does mkdir(backupPath, { recursive: true }),
		// which throws EEXIST on a path that already exists as a file. This
		// reproduces a setup failure (e.g. EACCES/ENOSPC) that occurs after the
		// LIVE_DB lock has been acquired.
		await writeFile(join(BACKUP_DIR, ID), 'not a directory');

		const result = await startBackup(ID, 'manual');

		expect(result.ok).toBe(false);
		// The lock must not be leaked, otherwise all future backups/restores
		// would be rejected with 409 until the next sidecar restart.
		expect(await readLock(LIVE_DB)).toBeNull();
	});
});
