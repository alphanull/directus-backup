/**
 * Import endpoint validation & security tests.
 *
 * Drives the real `POST /backup-api/upload` handler (no sidecar, no HTTP server)
 * via a mock router that captures the registered route handlers, a mock
 * Directus request carrying admin accountability, and a mock response. Archives
 * are built on disk and streamed through the handler exactly as an upload would
 * be, so the `tar`-based listing/extraction and the post-extraction cleanup run
 * for real.
 *
 * handleImport parses `tar tvzf` with a fixed 6-column GNU/BusyBox layout (the
 * format on the Alpine production image and Linux CI runners). macOS ships BSD
 * tar, whose 9-column listing this parser cannot read, so the archive-based
 * suite is skipped where the host tar does not match production. The auth and
 * "import disabled" gates run everywhere — they reject before any tar runs.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { rm, mkdir, mkdtemp, writeFile, readFile, access, symlink, link, truncate } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('../../src/api/core/sanity.js', () => ({
    getSanityReport: async () => ({ operational: true, ok: true, restoreReady: true, issues: [], checkedAt: '' }),
    installationError: () => ''
}));

import backupApi from '../../src/api/index.js';
import { acquireLock } from '../../src/api/storage/locks.js';
import { writeConfig, type BackupConfig } from '../../src/api/storage/config-store.js';
import { getFreeMB } from '../../src/api/storage/space.js';

const execFileP = promisify(execFile);
const { handler } = backupApi;

/** Casts a partial config for persistence; readConfig re-validates on the way out. */
const partialConfig = (p: Partial<BackupConfig>): BackupConfig => p as BackupConfig;

/** Holds a backup's own per-backup lock, as an active operation would. */
const lockBackup = (id: string): Promise<boolean> =>
    acquireLock(id, { backupId: id, startedAt: new Date().toISOString(), operation: 'restore' });

const VALID_ID = '2026-01-07__00-00-00__manual';
const OTHER_ID = '2026-01-08__00-00-00__manual';

let BACKUP_DIR: string;

// ── Mock Directus endpoint plumbing ───────────────────────────

type RouteMap = Record<string, Record<string, Function>>;

function createMockRouter(): { routes: RouteMap, router: any } {
    const routes: RouteMap = {};
    const register = (method: string) => (path: string, fn: Function): void => {
        routes[method] = routes[method] || {};
        routes[method][path] = fn;
    };
    return {
        routes,
        router: { get: register('GET'), post: register('POST'), put: register('PUT'), delete: register('DELETE') }
    };
}

function mockRes(): any {
    const res: any = { _status: 0, _json: null, _headers: {}, headersSent: false };
    res.status = (code: number) => { res._status = code; return res; };
    res.json = (data: any) => { res._json = data; res.headersSent = true; return res; };
    res.setHeader = (k: string, v: string) => { res._headers[k] = v; };
    res.writeHead = () => { res.headersSent = true; return res; };
    res.on = () => res;
    return res;
}

/** A request whose body streams `buf`, authenticated as an admin. */
function mockUploadReq(buf: Buffer): any {
    const req = Readable.from(buf) as any;
    req.accountability = { admin: true };
    req.params = {};
    req.query = {};
    req.body = {};
    return req;
}

/** Registers the endpoint and returns its captured routes. Import enabled by default. */
function registerRoutes(env: Record<string, string> = {}): RouteMap {
    const { routes, router } = createMockRouter();
    handler(router, {
        env: { BACKUP_DIR, BACKUP_IMPORT_ENABLED: 'true', BACKUP_EXPORT_ENABLED: 'true', ...env },
        database: () => ({ first: () => Promise.resolve(undefined) }),
        getSchema: async () => ({}),
        services: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
    return routes;
}

const uploadRoute = (routes: RouteMap): Function => routes.POST['/upload'];

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// ── Archive builders ──────────────────────────────────────────

const writeManifest = (dir: string, manifest: object): Promise<void> =>
    writeFile(join(dir, 'backup.json'), JSON.stringify(manifest));

/** Packs `topNames` from `staging` into a gzip tarball and returns its bytes. */
async function packTar(staging: string, topNames: string[]): Promise<Buffer> {
    const tarPath = join(staging, 'archive.tar.gz');
    await execFileP('tar', ['czf', tarPath, '-C', staging, ...topNames], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    return readFile(tarPath);
}

async function stage(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `import-${prefix}-`));
}

/** Valid DB-only archive: manifest (status success) + the declared database.dump. */
async function buildValid(id: string): Promise<Buffer> {
    const s = await stage('valid');
    try {
        await mkdir(join(s, id), { recursive: true });
        await writeManifest(join(s, id), { id, status: 'success', scope: { database: true, assets: false, extensions: false } });
        await writeFile(join(s, id, 'database.dump'), 'FAKE_DUMP');
        return await packTar(s, [id]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/** Manifest whose scope.includedCollections holds a shell-injection payload. */
async function buildBadCollection(id: string): Promise<Buffer> {
    const s = await stage('badcollection');
    try {
        await mkdir(join(s, id), { recursive: true });
        await writeManifest(join(s, id), {
            id,
            status: 'success',
            scope: { database: true, assets: false, extensions: false, includedCollections: ['ok', '$(touch /tmp/pwned)'] }
        });
        await writeFile(join(s, id, 'database.dump'), 'FAKE_DUMP');
        return await packTar(s, [id]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/** Manifest declares assets but the archive lacks uploads.tar.gz. */
async function buildInconsistent(id: string): Promise<Buffer> {
    const s = await stage('inconsistent');
    try {
        await mkdir(join(s, id), { recursive: true });
        await writeManifest(join(s, id), { id, status: 'success', scope: { database: true, assets: true, extensions: false } });
        await writeFile(join(s, id, 'database.dump'), 'FAKE_DUMP');
        return await packTar(s, [id]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/** Top-level directory name differs from the manifest's own id. */
async function buildMismatchedId(dirId: string, manifestId: string): Promise<Buffer> {
    const s = await stage('mismatch');
    try {
        await mkdir(join(s, dirId), { recursive: true });
        await writeManifest(join(s, dirId), { id: manifestId, status: 'success', scope: { database: true, assets: false, extensions: false } });
        await writeFile(join(s, dirId, 'database.dump'), 'FAKE_DUMP');
        return await packTar(s, [dirId]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/** Manifest with a non-success status. */
async function buildStatus(id: string, status: string): Promise<Buffer> {
    const s = await stage('status');
    try {
        await mkdir(join(s, id), { recursive: true });
        await writeManifest(join(s, id), { id, status, scope: { database: true, assets: false, extensions: false } });
        await writeFile(join(s, id, 'database.dump'), 'FAKE_DUMP');
        return await packTar(s, [id]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/** Archive directory without a backup.json. */
async function buildNoManifest(id: string): Promise<Buffer> {
    const s = await stage('nomanifest');
    try {
        await mkdir(join(s, id), { recursive: true });
        await writeFile(join(s, id, 'database.dump'), 'FAKE_DUMP');
        return await packTar(s, [id]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/** Archive containing a symlink (path-escape attempt). */
async function buildSymlink(id: string): Promise<Buffer> {
    const s = await stage('symlink');
    try {
        await mkdir(join(s, id), { recursive: true });
        await writeManifest(join(s, id), { id, status: 'success', scope: { database: true, assets: false, extensions: false } });
        await writeFile(join(s, id, 'database.dump'), 'FAKE_DUMP');
        await symlink('/etc/passwd', join(s, id, 'link.txt'));
        return await packTar(s, [id]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/** Archive containing a hard link (security boundary — must be rejected). */
async function buildHardlink(id: string): Promise<Buffer> {
    const s = await stage('hardlink');
    try {
        await mkdir(join(s, id), { recursive: true });
        await writeManifest(join(s, id), { id, status: 'success', scope: { database: true, assets: false, extensions: false } });
        await writeFile(join(s, id, 'database.dump'), 'FAKE_DUMP');
        await link(join(s, id, 'database.dump'), join(s, id, 'hardlink.dump'));
        return await packTar(s, [id]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/** Two top-level directories. */
async function buildMultiDir(): Promise<Buffer> {
    const s = await stage('multi');
    try {
        await mkdir(join(s, 'a'), { recursive: true });
        await mkdir(join(s, 'b'), { recursive: true });
        await writeFile(join(s, 'a', 'f'), 'x');
        await writeFile(join(s, 'b', 'f'), 'x');
        return await packTar(s, ['a', 'b']);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/** Single top-level directory whose name is not a valid backup ID. */
async function buildBadId(name: string): Promise<Buffer> {
    const s = await stage('badid');
    try {
        await mkdir(join(s, name), { recursive: true });
        await writeManifest(join(s, name), { id: name, status: 'success' });
        return await packTar(s, [name]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/**
 * Valid outer archive whose uploads.tar.gz contains a symlink. Verifies that
 * the inner-archive security check catches what the outer listing cannot see.
 */
async function buildInnerSymlink(id: string): Promise<Buffer> {
    const s = await stage('inner-symlink');
    try {
        await mkdir(join(s, id), { recursive: true });
        await writeManifest(join(s, id), { id, status: 'success', scope: { database: false, assets: true, extensions: false } });
        const innerS = await stage('inner-symlink-content');
        try {
            await symlink('/etc/passwd', join(innerS, 'link.txt'));
            await execFileP('tar', ['czf', join(s, id, 'uploads.tar.gz'), '-C', innerS, 'link.txt'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
        } finally {
            await rm(innerS, { recursive: true, force: true });
        }
        return await packTar(s, [id]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

/**
 * Valid archive plus a sparse `big.bin` of `bigBytes`, so the `tar tvzf` listing
 * reports a large uncompressed size while the archive stays tiny (zero-filled
 * sparse data compresses to almost nothing). Drives the pre-extraction size
 * guard without writing gigabytes.
 */
async function buildSparse(id: string, bigBytes: number): Promise<Buffer> {
    const s = await stage('sparse');
    try {
        await mkdir(join(s, id), { recursive: true });
        await writeManifest(join(s, id), { id, status: 'success', scope: { database: true, assets: false, extensions: false } });
        await writeFile(join(s, id, 'database.dump'), 'FAKE_DUMP');
        const big = join(s, id, 'big.bin');
        await writeFile(big, '');
        await truncate(big, bigBytes);
        return await packTar(s, [id]);
    } finally {
        await rm(s, { recursive: true, force: true });
    }
}

// ── tar-format probe (skip the archive suite where it cannot match) ──

function tarMatchesServerParse(): boolean {
    const s = mkdtempSync(join(tmpdir(), 'import-probe-'));
    try {
        mkdirSync(join(s, VALID_ID), { recursive: true });
        writeFileSync(join(s, VALID_ID, 'backup.json'), '{}');
        const tarPath = join(s, 'probe.tar.gz');
        execFileSync('tar', ['czf', tarPath, '-C', s, VALID_ID]);
        const stdout = execFileSync('tar', ['tvzf', tarPath]).toString();
        const tops = new Set<string>();
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 6) continue;
            const filename = parts.slice(5).join(' ').split(' -> ')[0];
            const top = filename.split('/')[0];
            if (top) tops.add(top);
        }
        return tops.size === 1 && tops.has(VALID_ID);
    } catch {
        return false;
    } finally {
        rmSync(s, { recursive: true, force: true });
    }
}

const TAR_OK = tarMatchesServerParse();

// ── Lifecycle ─────────────────────────────────────────────────

let prevInstance: string | undefined;

beforeAll(async () => {
    // Skip the boot reconcile + scheduler so importing the module under test
    // never arms a cron job or touches a real backup store on a worker.
    prevInstance = process.env.NODE_APP_INSTANCE;
    process.env.NODE_APP_INSTANCE = '1';
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'import-store-'));
});

afterAll(async () => {
    if (prevInstance === undefined) delete process.env.NODE_APP_INSTANCE;
    else process.env.NODE_APP_INSTANCE = prevInstance;
    await rm(BACKUP_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
    await rm(BACKUP_DIR, { recursive: true, force: true });
    await mkdir(BACKUP_DIR, { recursive: true });
});

// ── Gates that run without tar ────────────────────────────────

describe('import gating', () => {
    it('rejects an unauthenticated request with 403', async () => {
        const upload = uploadRoute(registerRoutes());
        const req: any = { accountability: undefined };
        const res = mockRes();
        await upload(req, res);
        expect(res._status).toBe(403);
    });

    it('rejects with 403 when import is disabled', async () => {
        const upload = uploadRoute(registerRoutes({ BACKUP_IMPORT_ENABLED: 'false' }));
        const req: any = { accountability: { admin: true } };
        const res = mockRes();
        await upload(req, res);
        expect(res._status).toBe(403);
        expect(res._json.code).toBe('IMPORT_DISABLED');
    });
});

// ── Archive validation & security (Linux/BusyBox tar only) ────

describe.skipIf(!TAR_OK)('import validation & security', () => {
    it('rejects an empty upload', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(Buffer.alloc(0)), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/empty upload/i);
    });

    it('rejects a corrupted (non-gzip) archive', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(Buffer.from('not a real gzip archive at all')), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/invalid or corrupted/i);
    });

    it('rejects an archive with multiple top-level directories', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildMultiDir()), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/exactly one backup directory/i);
    });

    it('rejects an archive whose directory name is not a valid backup ID', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildBadId('evil')), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/not a valid backup id/i);
    });

    it('rejects an archive containing a symlink (security risk)', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildSymlink(VALID_ID)), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/symlink/i);
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });

    it('rejects an archive containing a hard link (security risk)', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildHardlink(VALID_ID)), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/hard link/i);
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });

    it('rejects an archive without a manifest', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildNoManifest(VALID_ID)), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/valid backup manifest/i);
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });

    it('rejects an archive whose manifest id does not match its directory name', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildMismatchedId(VALID_ID, OTHER_ID)), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/manifest id does not match/i);
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });

    it('rejects an archive whose manifest status is not success', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildStatus(VALID_ID, 'running')), res);
        expect(res._status).toBe(409);
        expect(res._json.error).toMatch(/only successful backups/i);
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });

    it('rejects an archive that declares a component it does not contain', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildInconsistent(VALID_ID)), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/uploads\.tar\.gz is missing/i);
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });

    it('rejects an archive whose inner uploads.tar.gz contains a symlink', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildInnerSymlink(VALID_ID)), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/uploads\.tar\.gz failed security validation/i);
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });

    it('rejects an archive whose manifest carries an invalid collection name', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildBadCollection(VALID_ID)), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/invalid collection name/i);
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });

    it('accepts a valid archive and writes it to the store', async () => {
        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildValid(VALID_ID)), res);
        expect(res._status).toBe(200);
        expect(res._json.id).toBe(VALID_ID);
        expect(await exists(join(BACKUP_DIR, VALID_ID, 'database.dump'))).toBe(true);
    });

    it('rejects importing a backup that already exists with 409', async () => {
        await mkdir(join(BACKUP_DIR, VALID_ID), { recursive: true });
        await writeManifest(join(BACKUP_DIR, VALID_ID), { id: VALID_ID, status: 'success' });

        const upload = uploadRoute(registerRoutes());
        const res = mockRes();
        await upload(mockUploadReq(await buildValid(VALID_ID)), res);
        expect(res._status).toBe(409);
        expect(res._json.error).toMatch(/already exists/i);
    });
});

// ── Concurrency & storage guards (Linux/BusyBox tar only) ─────

describe.skipIf(!TAR_OK)('import concurrency & storage guards', () => {
    it('rejects import while that backup ID is locked by another operation', async () => {
        const upload = uploadRoute(registerRoutes());
        await lockBackup(VALID_ID);
        const res = mockRes();
        await upload(mockUploadReq(await buildValid(VALID_ID)), res);
        expect(res._status).toBe(409);
        expect(res._json.error).toMatch(/in use/i);
        // Nothing should have been extracted while the lock was held.
        expect(await exists(join(BACKUP_DIR, VALID_ID, 'backup.json'))).toBe(false);
    });

    it('allows import while a different backup is locked (per-backup lock)', async () => {
        const upload = uploadRoute(registerRoutes());
        await lockBackup(OTHER_ID);
        const res = mockRes();
        await upload(mockUploadReq(await buildValid(VALID_ID)), res);
        expect(res._status).toBe(200);
        expect(await exists(join(BACKUP_DIR, VALID_ID, 'backup.json'))).toBe(true);
    });

    it('rejects an archive whose extracted size would breach the free-space margin', async () => {
        const upload = uploadRoute(registerRoutes());
        const free = getFreeMB();
        if (free === null) return; // df unavailable: minFreeMB guard disabled (quotaMB fallback only applies when quotaMB > 0).

        // Leave ~20MB headroom so the tiny compressed upload fits but a 200MB
        // (sparse) extraction does not.
        await writeConfig(partialConfig({ minFreeMB: Math.max(1, free - 20) }));
        const res = mockRes();
        await upload(mockUploadReq(await buildSparse(VALID_ID, 200 * 1024 * 1024)), res);
        expect(res._status).toBe(507);
        // Rejected before extraction — nothing written.
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });

    it('rejects an archive whose extracted size would exceed the quota (pre-extraction)', async () => {
        const upload = uploadRoute(registerRoutes());
        // 10MB quota, free-space guard disabled — any import > 10MB must be
        // rejected before tar extracts.
        await writeConfig(partialConfig({ quotaMB: 10, minFreeMB: 0 }));
        const res = mockRes();
        await upload(mockUploadReq(await buildSparse(VALID_ID, 50 * 1024 * 1024)), res);
        expect(res._status).toBe(507);
        expect(res._json.code).toBe('QUOTA_IMPORT_EXCEEDED');
        expect(await exists(join(BACKUP_DIR, VALID_ID))).toBe(false);
    });
});
