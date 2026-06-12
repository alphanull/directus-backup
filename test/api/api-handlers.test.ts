/**
 * HTTP handler behaviour: access control, delete/download/cancel guards, and
 * per-request scope validation.
 *
 * Adapted from the sidecar `server-handlers` suite. The sidecar authenticated
 * via an `X-Backup-Secret` header against a real `http` server; the standalone
 * authenticates via Directus accountability, so these drive the registered
 * route handlers directly through a mock router with admin/policy accountability
 * and a mock response. The download success path uses a `PassThrough` response
 * so `tar | res` streaming runs for real.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { rm, mkdir, mkdtemp, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import backupApi from '../../src/api/index.js';
import { writeManifest } from '../../src/api/storage/manifest.js';
import { acquireLock, readLock } from '../../src/api/storage/locks.js';

const { handler } = backupApi;

const ID = '2026-01-05__00-00-00__manual';
const OTHER = '2026-01-06__00-00-00__manual';

let BACKUP_DIR: string;
let prevInstance: string | undefined;

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

/** A PassThrough-backed response: captures status/json/headers and can be piped into. */
function mockRes(): any {
    const res: any = new PassThrough();
    res._status = 0;
    res._json = null;
    res._headers = {};
    res._writeHeadStatus = 0;
    res.headersSent = false;
    res.status = (code: number) => { res._status = code; return res; };
    res.json = (data: any) => { res._json = data; res.headersSent = true; return res; };
    res.setHeader = (k: string, v: string) => { res._headers[k] = v; };
    res.writeHead = (code: number, h?: Record<string, string>) => {
        res._writeHeadStatus = code;
        if (h) Object.assign(res._headers, h);
        res.headersSent = true;
        return res;
    };
    return res;
}

/** A request authenticated as the given accountability, with params/body/query. */
function req(accountability: any, opts: { params?: Record<string, string>, body?: any, query?: any } = {}): any {
    return {
        accountability,
        params: opts.params ?? {},
        body: opts.body ?? {},
        query: opts.query ?? {}
    };
}

const admin = (opts?: { params?: Record<string, string>, body?: any, query?: any }) => req({ admin: true }, opts);

/** A database stub whose policy lookup resolves to `row` (truthy → access granted). */
function makeDb(row: any) {
    return () => {
        const b: any = {};
        b.join = () => b;
        b.where = () => b;
        b.whereIn = () => b;
        b.orWhere = () => b;
        b.andWhere = (fn: any) => { if (typeof fn === 'function') fn.call(b); return b; };
        b.first = () => Promise.resolve(row);
        return b;
    };
}

/** Registers the endpoint and returns its captured routes. */
function registerRoutes(env: Record<string, string> = {}, database: any = makeDb(undefined)): RouteMap {
    const { routes, router } = createMockRouter();
    handler(router, {
        env: { BACKUP_DIR, BACKUP_IMPORT_ENABLED: 'true', BACKUP_EXPORT_ENABLED: 'true', ...env },
        database,
        getSchema: async () => ({}),
        services: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
    return routes;
}

const seedBackup = (id: string, status = 'success'): Promise<void> =>
    writeManifest(join(BACKUP_DIR, id), { id, status });

/** A restore of `id` holds that backup's own per-backup lock. */
const lockBackup = (id: string): Promise<boolean> =>
    acquireLock(id, { backupId: id, startedAt: new Date().toISOString(), operation: 'restore' });

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 20; i++) {
        if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

// ── Lifecycle ─────────────────────────────────────────────────

beforeAll(async () => {
    prevInstance = process.env.NODE_APP_INSTANCE;
    process.env.NODE_APP_INSTANCE = '1';
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'dbk-handlers-'));
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

// ── Access control (replaces the sidecar's secret-header gate) ──

describe('access control', () => {
    it('grants an admin', async () => {
        const route = registerRoutes().GET['/check-access'];
        const res = mockRes();
        await route(admin(), res);
        expect(res._json).toEqual({ access: true });
    });

    it('rejects a request without accountability (403)', async () => {
        const route = registerRoutes().GET['/check-access'];
        const res = mockRes();
        await route(req(undefined), res);
        expect(res._status).toBe(403);
    });

    it('rejects a non-admin with no user and no roles (403)', async () => {
        const route = registerRoutes().GET['/check-access'];
        const res = mockRes();
        await route(req({ admin: false, user: null, roles: [] }), res);
        expect(res._status).toBe(403);
    });

    it('grants a non-admin holding the Backup Access policy', async () => {
        const route = registerRoutes({}, makeDb({ id: 'access-row' })).GET['/check-access'];
        const res = mockRes();
        await route(req({ admin: false, user: 'u1', roles: ['r1'] }), res);
        expect(res._json).toEqual({ access: true });
    });

    it('rejects a non-admin without the policy (403)', async () => {
        const route = registerRoutes({}, makeDb(undefined)).GET['/check-access'];
        const res = mockRes();
        await route(req({ admin: false, user: 'u1', roles: ['r1'] }), res);
        expect(res._status).toBe(403);
    });
});

// ── DELETE guards ─────────────────────────────────────────────

describe('delete guards', () => {
    const del = (routes: RouteMap): Function => routes.DELETE['/:id'];

    it('rejects delete without access (403)', async () => {
        await seedBackup(ID);
        const res = mockRes();
        await del(registerRoutes())(req(undefined, { params: { id: ID } }), res);
        expect(res._status).toBe(403);
        expect(await exists(join(BACKUP_DIR, ID))).toBe(true);
    });

    it('returns 404 when the backup does not exist', async () => {
        const res = mockRes();
        await del(registerRoutes())(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(404);
    });

    it('rejects deleting a backup that is still being created (status running)', async () => {
        await seedBackup(ID, 'running');
        const res = mockRes();
        await del(registerRoutes())(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(409);
        expect(await exists(join(BACKUP_DIR, ID))).toBe(true);
    });

    it('rejects delete while that backup is locked', async () => {
        const routes = registerRoutes();
        await seedBackup(ID);
        await lockBackup(ID);
        const res = mockRes();
        await del(routes)(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(409);
        expect(await exists(join(BACKUP_DIR, ID))).toBe(true);
    });

    it('allows delete while a different backup is locked (per-backup lock)', async () => {
        const routes = registerRoutes();
        await seedBackup(ID);
        await lockBackup(OTHER);
        const res = mockRes();
        await del(routes)(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(200);
        expect(await exists(join(BACKUP_DIR, ID))).toBe(false);
    });

    it('allows delete once no lock is held and removes the directory', async () => {
        const routes = registerRoutes();
        await seedBackup(ID);
        const res = mockRes();
        await del(routes)(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(200);
        expect(await exists(join(BACKUP_DIR, ID))).toBe(false);
    });
});

// ── DOWNLOAD guards ───────────────────────────────────────────

describe('download guards', () => {
    const dl = (routes: RouteMap): Function => routes.GET['/:id/download'];

    it('rejects download without access (403)', async () => {
        await seedBackup(ID);
        const res = mockRes();
        await dl(registerRoutes())(req(undefined, { params: { id: ID } }), res);
        expect(res._status).toBe(403);
    });

    it('rejects download when export is disabled (403)', async () => {
        await seedBackup(ID);
        const res = mockRes();
        await dl(registerRoutes({ BACKUP_EXPORT_ENABLED: 'false' }))(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(403);
        expect(res._json.code).toBe('EXPORT_DISABLED');
    });

    it('returns 404 when the backup does not exist', async () => {
        const res = mockRes();
        await dl(registerRoutes())(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(404);
    });

    it('rejects downloading a running backup (409)', async () => {
        await seedBackup(ID, 'running');
        const res = mockRes();
        await dl(registerRoutes())(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(409);
    });

    it('rejects download while that backup is locked (409)', async () => {
        const routes = registerRoutes();
        await seedBackup(ID);
        await lockBackup(ID);
        const res = mockRes();
        await dl(routes)(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(409);
    });

    it('streams (writeHead 200) while a different backup is locked', async () => {
        const routes = registerRoutes();
        await seedBackup(ID);
        await lockBackup(OTHER);
        const res = mockRes();
        await dl(routes)(admin({ params: { id: ID } }), res);
        await waitFor(() => res._writeHeadStatus === 200);
        expect(res._writeHeadStatus).toBe(200);
        // Drain the tar stream so the child exits and the lock is released.
        res.resume();
        await Promise.race([once(res, 'finish'), once(res, 'close')]);
    });

    it('returns 500 JSON if tar cannot start before headers are sent', async () => {
        const routes = registerRoutes();
        await seedBackup(ID);
        const res = mockRes();
        const oldPath = process.env.PATH;
        process.env.PATH = '/no-such-tar-path';
        try {
            await dl(routes)(admin({ params: { id: ID } }), res);
            await waitFor(() => res._status === 500);
        } finally {
            process.env.PATH = oldPath;
        }

        expect(res._writeHeadStatus).toBe(0);
        expect(res._status).toBe(500);
        expect(res._json.error).toBe('Archive failed');
        expect(await readLock(ID)).toBeNull();
    });
});

// ── CANCEL handler ────────────────────────────────────────────

describe('cancel handler', () => {
    const cancel = (routes: RouteMap): Function => routes.POST['/:id/cancel'];

    it('returns 403 without access', async () => {
        const res = mockRes();
        await cancel(registerRoutes())(req(undefined, { params: { id: ID } }), res);
        expect(res._status).toBe(403);
    });

    it('returns 400 for an invalid backupId', async () => {
        const res = mockRes();
        await cancel(registerRoutes())(admin({ params: { id: 'not-a-valid-id' } }), res);
        expect(res._status).toBe(400);
    });

    it('returns 404 when the backup does not exist', async () => {
        const res = mockRes();
        await cancel(registerRoutes())(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(404);
    });

    it('returns 409 when the backup exists but is not running', async () => {
        await seedBackup(ID, 'success');
        const res = mockRes();
        await cancel(registerRoutes())(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(409);
        expect(res._json.error).toMatch(/not running/i);
    });

    it('returns 409 when the manifest says running but no process is registered', async () => {
        await seedBackup(ID, 'running');
        const res = mockRes();
        await cancel(registerRoutes())(admin({ params: { id: ID } }), res);
        expect(res._status).toBe(409);
        expect(res._json.error).toMatch(/process not found/i);
    });
});

// ── Per-request scope validation ──────────────────────────────

describe('scope validation', () => {
    const putConfig = (routes: RouteMap): Function => routes.PUT['/config'];
    const create = (routes: RouteMap): Function => routes.POST['/create'];
    const restore = (routes: RouteMap): Function => routes.POST['/:id/restore'];

    const putBody = (backupScope: unknown) => admin({ body: { backupScope } });

    it('rejects PUT /config with a non-object backupScope', async () => {
        const res = mockRes();
        await putConfig(registerRoutes())(putBody('nope'), res);
        expect(res._status).toBe(400);
    });

    it('rejects PUT /config with a non-string includeCollections entry', async () => {
        const res = mockRes();
        await putConfig(registerRoutes())(putBody({ includeCollections: [1, 2] }), res);
        expect(res._status).toBe(400);
    });

    it('rejects PUT /config with a non-string excludedCollections entry', async () => {
        const res = mockRes();
        await putConfig(registerRoutes())(putBody({ excludedCollections: [1, 2] }), res);
        expect(res._status).toBe(400);
    });

    it('rejects PUT /config with a shell-metacharacter excludedCollections name', async () => {
        const res = mockRes();
        await putConfig(registerRoutes())(putBody({ excludedCollections: ['ok_name', 'rm -rf *'] }), res);
        expect(res._status).toBe(400);
    });

    it('accepts PUT /config with a valid excludedCollections blocklist', async () => {
        const res = mockRes();
        await putConfig(registerRoutes())(putBody({ database: true, assets: true, extensions: false, excludedCollections: ['analytics_events'] }), res);
        expect(res._status).toBe(200);
    });

    it('accepts PUT /config with a valid snake_case includeCollections allowlist', async () => {
        const res = mockRes();
        await putConfig(registerRoutes())(putBody({ includeCollections: ['articles', 'directus_users'] }), res);
        expect(res._status).toBe(200);
    });

    it('accepts PUT /config with mixed-case and hyphenated collection names', async () => {
        const res = mockRes();
        await putConfig(registerRoutes())(putBody({ excludedCollections: ['MyCollection', 'legacy-events'] }), res);
        expect(res._status).toBe(200);
    });

    it('rejects POST /create with an invalid scope (before starting a backup)', async () => {
        const res = mockRes();
        await create(registerRoutes())(admin({ body: { scope: { includeCollections: 'x' } } }), res);
        expect(res._status).toBe(400);
    });

    it('rejects POST /:id/restore with an invalid scope (before reading the manifest)', async () => {
        const res = mockRes();
        await restore(registerRoutes())(admin({ params: { id: ID }, body: { scope: { includeCollections: [1] } } }), res);
        expect(res._status).toBe(400);
    });

    it('rejects POST /:id/restore with a SQL-identifier injection in includeCollections', async () => {
        const res = mockRes();
        await restore(registerRoutes())(admin({ params: { id: ID }, body: { scope: { includeCollections: ['x";DROP/**/TABLE/**/foo;--'] } } }), res);
        expect(res._status).toBe(400);
    });

    it('rejects POST /:id/restore with an all-false scope (no-op would trigger restart)', async () => {
        const res = mockRes();
        await restore(registerRoutes())(admin({ params: { id: ID }, body: { scope: { database: false, assets: false, extensions: false } } }), res);
        expect(res._status).toBe(400);
    });

    it('rejects POST /create with a quote in a collection name', async () => {
        const res = mockRes();
        await create(registerRoutes())(admin({ body: { scope: { includeCollections: ['valid', 'bad"name'] } } }), res);
        expect(res._status).toBe(400);
    });

    it('rejects POST /create with an all-false scope (no component selected)', async () => {
        const res = mockRes();
        await create(registerRoutes())(admin({ body: { scope: { database: false, assets: false, extensions: false } } }), res);
        expect(res._status).toBe(400);
    });

    it('rejects PUT /config with an all-false backupScope (no component selected)', async () => {
        const res = mockRes();
        await putConfig(registerRoutes())(putBody({ database: false, assets: false, extensions: false }), res);
        expect(res._status).toBe(400);
    });
});
