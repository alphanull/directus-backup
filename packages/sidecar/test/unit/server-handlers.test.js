import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { rm, mkdir, access, mkdtemp, writeFile, readFile, truncate } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { BACKUP_DIR, LIVE_DB } from '../../lib/config.js';
import { writeManifest, acquireLock, writeConfig, getFreeMB } from '../../lib/storage.js';
import { requestHandler } from '../../server.js';

const execFileP = promisify(execFile);

// Matches BACKUP_SECRET injected by vitest.config.js.
const headers = { 'X-Backup-Secret': 'test-secret' };
const ID = '2026-01-05__00-00-00__manual';
const OTHER = '2026-01-06__00-00-00__manual';
const IMPORT_ID = '2026-01-07__00-00-00__manual';

let baseUrl;
let server;

beforeAll(async () => {
	server = createServer(requestHandler);
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
	await new Promise(resolve => server.close(resolve));
	await rm(BACKUP_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
	// Removing the whole dir also clears any leftover lock file.
	await rm(BACKUP_DIR, { recursive: true, force: true });
	await mkdir(BACKUP_DIR, { recursive: true });
});

const seedBackup = (id, status = 'success') => writeManifest(join(BACKUP_DIR, id), { id, status });
// A restore of `id` holds both the LIVE_DB lock and that backup's own lock.
const lockFor = async id => {
	await acquireLock(LIVE_DB, { backupId: id, startedAt: new Date().toISOString(), operation: 'restore' });
	await acquireLock(id, { backupId: id, startedAt: new Date().toISOString(), operation: 'restore' });
};
const exists = async path => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};
// Builds a minimal but valid import archive containing `<id>/backup.json`
// (status success, DB-only scope) plus the `database.dump` its scope declares,
// and returns its gzip bytes. The dump file is required because import now
// rejects archives whose manifest declares a component the archive lacks.
// Cleans up its staging dir.
const buildArchive = async id => {
	const staging = await mkdtemp(join(tmpdir(), 'import-stage-'));
	try {
		await mkdir(join(staging, id), { recursive: true });
		await writeFile(join(staging, id, 'backup.json'), JSON.stringify({
			id, status: 'success', scope: { database: true, assets: false, extensions: false }
		}));
		await writeFile(join(staging, id, 'database.dump'), 'FAKE_DUMP');
		const tarPath = join(staging, 'archive.tar.gz');
		await execFileP('tar', ['czf', tarPath, '-C', staging, id]);
		return await readFile(tarPath);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
};

// Builds an archive whose manifest declares a component (assets) that the
// archive does not actually contain — the inconsistency the import hardening
// must reject. Cleans up its staging dir.
const buildInconsistentArchive = async id => {
	const staging = await mkdtemp(join(tmpdir(), 'import-bad-'));
	try {
		await mkdir(join(staging, id), { recursive: true });
		await writeFile(join(staging, id, 'backup.json'), JSON.stringify({
			id, status: 'success', scope: { database: true, assets: true, extensions: false }
		}));
		await writeFile(join(staging, id, 'database.dump'), 'FAKE_DUMP');
		// uploads.tar.gz intentionally absent though scope.assets is true.
		const tarPath = join(staging, 'archive.tar.gz');
		await execFileP('tar', ['czf', tarPath, '-C', staging, id]);
		return await readFile(tarPath);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
};

// Builds an archive whose top-level directory name does not match the
// manifest's own `id` — the inconsistency the import id-binding check rejects.
// Cleans up its staging dir.
const buildMismatchedIdArchive = async (dirId, manifestId) => {
	const staging = await mkdtemp(join(tmpdir(), 'import-idmismatch-'));
	try {
		await mkdir(join(staging, dirId), { recursive: true });
		await writeFile(join(staging, dirId, 'backup.json'), JSON.stringify({
			id: manifestId, status: 'success', scope: { database: true, assets: false, extensions: false }
		}));
		await writeFile(join(staging, dirId, 'database.dump'), 'FAKE_DUMP');
		const tarPath = join(staging, 'archive.tar.gz');
		await execFileP('tar', ['czf', tarPath, '-C', staging, dirId]);
		return await readFile(tarPath);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
};

// Like buildArchive, but adds a sparse file of `bigBytes` so the `tar tvzf`
// listing reports a large uncompressed size while the archive itself stays
// tiny (a zero-filled sparse file compresses to almost nothing). Used to drive
// the pre-extraction size guard without writing gigabytes.
const buildSparseArchive = async (id, bigBytes) => {
	const staging = await mkdtemp(join(tmpdir(), 'import-sparse-'));
	try {
		await mkdir(join(staging, id), { recursive: true });
		await writeFile(join(staging, id, 'backup.json'), JSON.stringify({
			id, status: 'success', scope: { database: true, assets: false, extensions: false }
		}));
		await writeFile(join(staging, id, 'database.dump'), 'FAKE_DUMP');
		const big = join(staging, id, 'big.bin');
		await writeFile(big, '');
		await truncate(big, bigBytes);
		const tarPath = join(staging, 'archive.tar.gz');
		await execFileP('tar', ['czf', tarPath, '-C', staging, id]);
		return await readFile(tarPath);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
};

// handleImport lists the upload with `tar tvzf` and parses a fixed 6-column,
// GNU/BusyBox layout (owner/group as one field) — the format produced by the
// Alpine production image and GitHub's Linux runners. macOS ships BSD tar,
// whose 9-column listing this parser cannot read. Replicate that exact parse
// against the host's tar so the import tests run wherever the format matches
// production and skip (rather than fail) where it does not. Done synchronously
// to keep `describe.skipIf` resolvable at collection time without a top-level
// await (which would evaluate the server module before vitest injects test env).
const tarMatchesServerParse = () => {
	const staging = mkdtempSync(join(tmpdir(), 'import-probe-'));
	try {
		mkdirSync(join(staging, IMPORT_ID), { recursive: true });
		writeFileSync(join(staging, IMPORT_ID, 'backup.json'), '{}');
		const tarPath = join(staging, 'probe.tar.gz');
		execFileSync('tar', ['czf', tarPath, '-C', staging, IMPORT_ID]);
		const stdout = execFileSync('tar', ['tvzf', tarPath]).toString();
		const tops = new Set();
		for (const line of stdout.trim().split('\n').filter(Boolean)) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 6) continue;
			const filename = parts.slice(5).join(' ').split(' -> ')[0];
			const top = filename.split('/')[0];
			if (top) tops.add(top);
		}
		return tops.size === 1 && tops.has(IMPORT_ID);
	} catch {
		return false;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
};

const TAR_MATCHES_SERVER = tarMatchesServerParse();

describe('delete/download concurrency guards', () => {
	it('rejects delete while a restore lock is held for that backup', async () => {
		await seedBackup(ID);
		await lockFor(ID);

		const res = await fetch(`${baseUrl}/backup/${ID}`, { method: 'DELETE', headers });
		expect(res.status).toBe(409);
		expect(await exists(join(BACKUP_DIR, ID))).toBe(true);
	});

	it('rejects download while a restore lock is held for that backup', async () => {
		await seedBackup(ID);
		await lockFor(ID);

		const res = await fetch(`${baseUrl}/backup/${ID}/download`, { headers });
		expect(res.status).toBe(409);
	});

	it('allows delete while a different backup is locked (per-backup lock)', async () => {
		await seedBackup(ID);
		await lockFor(OTHER);

		const res = await fetch(`${baseUrl}/backup/${ID}`, { method: 'DELETE', headers });
		expect(res.status).toBe(200);
		expect(await exists(join(BACKUP_DIR, ID))).toBe(false);
	});

	it('allows download while a different backup is locked (per-backup lock)', async () => {
		await seedBackup(ID);
		await lockFor(OTHER);

		const res = await fetch(`${baseUrl}/backup/${ID}/download`, { headers });
		await res.arrayBuffer();
		expect(res.status).toBe(200);
	});

	it('allows delete once no lock is held and removes the directory', async () => {
		await seedBackup(ID);

		const res = await fetch(`${baseUrl}/backup/${ID}`, { method: 'DELETE', headers });
		expect(res.status).toBe(200);
		expect(await exists(join(BACKUP_DIR, ID))).toBe(false);
	});

	it('rejects delete of a backup that is still being created (status running)', async () => {
		await seedBackup(ID, 'running');

		const res = await fetch(`${baseUrl}/backup/${ID}`, { method: 'DELETE', headers });
		expect(res.status).toBe(409);
	});

	it('rejects delete without the secret header', async () => {
		await seedBackup(ID);

		const res = await fetch(`${baseUrl}/backup/${ID}`, { method: 'DELETE' });
		expect(res.status).toBe(403);
	});
});

describe.skipIf(!TAR_MATCHES_SERVER)('import concurrency guards', () => {
	it('rejects import while that backup ID is locked by another operation', async () => {
		await lockFor(IMPORT_ID);
		const archive = await buildArchive(IMPORT_ID);

		const res = await fetch(`${baseUrl}/import`, { method: 'POST', headers, body: archive });
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/in use/i);
		// Nothing should have been extracted while the lock was held.
		expect(await exists(join(BACKUP_DIR, IMPORT_ID))).toBe(false);
	});

	it('allows import while a different backup is locked (per-backup lock)', async () => {
		await lockFor(OTHER);
		const archive = await buildArchive(IMPORT_ID);

		const res = await fetch(`${baseUrl}/import`, { method: 'POST', headers, body: archive });
		expect(res.status).toBe(200);
		expect(await exists(join(BACKUP_DIR, IMPORT_ID, 'backup.json'))).toBe(true);
	});

	it('rejects import without the secret header', async () => {
		const archive = await buildArchive(IMPORT_ID);

		const res = await fetch(`${baseUrl}/import`, { method: 'POST', body: archive });
		expect(res.status).toBe(403);
	});
});

describe.skipIf(!TAR_MATCHES_SERVER)('import storage guards', () => {
	it('rejects an archive whose extracted size would breach the free-space margin', async () => {
		const free = getFreeMB();
		if (free === null) return; // df unavailable: the free-space guard is best-effort and disabled.

		// Leave ~20MB of headroom so the tiny compressed upload fits but a 200MB
		// (sparse) extraction does not.
		await writeConfig({ minFreeMB: Math.max(1, free - 20) });
		const archive = await buildSparseArchive(IMPORT_ID, 200 * 1024 * 1024);

		const res = await fetch(`${baseUrl}/import`, { method: 'POST', headers, body: archive });
		expect(res.status).toBe(507);
		// Rejected before extraction — nothing written.
		expect(await exists(join(BACKUP_DIR, IMPORT_ID))).toBe(false);
	});

	it('rejects an archive whose extracted size would exceed the quota (pre-extraction)', async () => {
		// 10MB quota, empty dir — any import > 10MB must be rejected before tar runs.
		await writeConfig({ quotaMB: 10 });
		const archive = await buildSparseArchive(IMPORT_ID, 50 * 1024 * 1024);

		const res = await fetch(`${baseUrl}/import`, { method: 'POST', headers, body: archive });
		expect(res.status).toBe(507);
		expect((await res.json()).code).toBe('QUOTA_IMPORT_EXCEEDED');
		// Rejected before extraction — nothing written.
		expect(await exists(join(BACKUP_DIR, IMPORT_ID))).toBe(false);
	});
});

describe.skipIf(!TAR_MATCHES_SERVER)('import scope/content consistency', () => {
	it('rejects an archive whose manifest declares a component the archive lacks', async () => {
		const archive = await buildInconsistentArchive(IMPORT_ID);

		const res = await fetch(`${baseUrl}/import`, { method: 'POST', headers, body: archive });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/uploads\.tar\.gz is missing/i);
		// Inconsistent archive must not be left behind in the store.
		expect(await exists(join(BACKUP_DIR, IMPORT_ID))).toBe(false);
	});

	it('accepts an archive whose manifest scope matches its contents', async () => {
		const archive = await buildArchive(IMPORT_ID);

		const res = await fetch(`${baseUrl}/import`, { method: 'POST', headers, body: archive });
		expect(res.status).toBe(200);
		expect(await exists(join(BACKUP_DIR, IMPORT_ID, 'database.dump'))).toBe(true);
	});

	it('rejects an archive whose manifest id does not match its directory name', async () => {
		const archive = await buildMismatchedIdArchive(IMPORT_ID, OTHER);

		const res = await fetch(`${baseUrl}/import`, { method: 'POST', headers, body: archive });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/manifest id does not match/i);
		// Mismatched archive must not be left behind in the store.
		expect(await exists(join(BACKUP_DIR, IMPORT_ID))).toBe(false);
	});
});

describe('per-run scope validation', () => {
	it('rejects PUT /config with a non-object backupScope', async () => {
		const res = await fetch(`${baseUrl}/config`, {
			method: 'PUT', headers, body: JSON.stringify({ backupScope: 'nope' })
		});
		expect(res.status).toBe(400);
	});

	it('rejects PUT /config with a non-string includeCollections entry', async () => {
		const res = await fetch(`${baseUrl}/config`, {
			method: 'PUT', headers, body: JSON.stringify({ backupScope: { includeCollections: [1, 2] } })
		});
		expect(res.status).toBe(400);
	});

	it('rejects PUT /config with a non-string excludedCollections entry', async () => {
		const res = await fetch(`${baseUrl}/config`, {
			method: 'PUT', headers, body: JSON.stringify({ backupScope: { excludedCollections: [1, 2] } })
		});
		expect(res.status).toBe(400);
	});

	it('accepts PUT /config with a valid excludedCollections blocklist', async () => {
		const res = await fetch(`${baseUrl}/config`, {
			method: 'PUT', headers, body: JSON.stringify({ backupScope: { database: true, assets: true, extensions: false, excludedCollections: ['analytics_events'] } })
		});
		expect(res.status).toBe(200);
	});

	it('rejects POST /run with an invalid scope (before starting a backup)', async () => {
		const res = await fetch(`${baseUrl}/run`, {
			method: 'POST', headers, body: JSON.stringify({ backupId: ID, source: 'manual', scope: { includeCollections: 'x' } })
		});
		expect(res.status).toBe(400);
	});

	it('rejects POST /restore with an invalid scope (before reading the manifest)', async () => {
		const res = await fetch(`${baseUrl}/restore`, {
			method: 'POST', headers, body: JSON.stringify({ backupId: ID, scope: { includeCollections: [1] } })
		});
		expect(res.status).toBe(400);
	});

	it('rejects POST /restore with a SQL-identifier injection in includeCollections', async () => {
		const res = await fetch(`${baseUrl}/restore`, {
			method: 'POST', headers, body: JSON.stringify({ backupId: ID, scope: { includeCollections: ['x";DROP/**/TABLE/**/foo;--'] } })
		});
		expect(res.status).toBe(400);
	});

	it('rejects POST /run with a quote in a collection name', async () => {
		const res = await fetch(`${baseUrl}/run`, {
			method: 'POST', headers, body: JSON.stringify({ backupId: ID, source: 'manual', scope: { includeCollections: ['valid', 'bad"name'] } })
		});
		expect(res.status).toBe(400);
	});

	it('rejects PUT /config with a shell-metacharacter excludedCollections name', async () => {
		const res = await fetch(`${baseUrl}/config`, {
			method: 'PUT', headers, body: JSON.stringify({ backupScope: { excludedCollections: ['ok_name', 'rm -rf *'] } })
		});
		expect(res.status).toBe(400);
	});

	it('accepts PUT /config with a valid snake_case includeCollections allowlist', async () => {
		const res = await fetch(`${baseUrl}/config`, {
			method: 'PUT', headers, body: JSON.stringify({ backupScope: { includeCollections: ['articles', 'directus_users'] } })
		});
		expect(res.status).toBe(200);
	});

	it('accepts PUT /config with mixed-case and hyphenated collection names', async () => {
		const res = await fetch(`${baseUrl}/config`, {
			method: 'PUT', headers, body: JSON.stringify({ backupScope: { excludedCollections: ['MyCollection', 'legacy-events'] } })
		});
		expect(res.status).toBe(200);
	});
});

describe('cancel handler', () => {
	it('returns 403 without the secret header', async () => {
		const res = await fetch(`${baseUrl}/cancel`, {
			method: 'POST', body: JSON.stringify({ backupId: ID })
		});
		expect(res.status).toBe(403);
	});

	it('returns 400 for an invalid backupId', async () => {
		const res = await fetch(`${baseUrl}/cancel`, {
			method: 'POST', headers, body: JSON.stringify({ backupId: 'not-a-valid-id' })
		});
		expect(res.status).toBe(400);
	});

	it('returns 404 when the backup does not exist', async () => {
		const res = await fetch(`${baseUrl}/cancel`, {
			method: 'POST', headers, body: JSON.stringify({ backupId: ID })
		});
		expect(res.status).toBe(404);
	});

	it('returns 409 when the backup exists but is not running', async () => {
		await seedBackup(ID, 'success');
		const res = await fetch(`${baseUrl}/cancel`, {
			method: 'POST', headers, body: JSON.stringify({ backupId: ID })
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/not running/i);
	});

	it('returns 409 when the manifest says running but no process is registered (e.g. after restart)', async () => {
		// A manifest left at status "running" with no active child process is the
		// state recoverStaleLocks() normally cleans up — but during the test we
		// simulate a scenario where handleCancel() sees it before recovery runs.
		await seedBackup(ID, 'running');
		const res = await fetch(`${baseUrl}/cancel`, {
			method: 'POST', headers, body: JSON.stringify({ backupId: ID })
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/process not found/i);
	});
});
