import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';

// The default export provides { id, handler }
import backupApi from '../../src/api/index.js';

const { handler } = backupApi;

// ── Mock sidecar (real HTTP server) ────────────────────────

let sidecar: Server;
let sidecarPort: number;
let sidecarHandler: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
	sidecarHandler = (_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('{}');
	};

	sidecar = createServer((req, res) => sidecarHandler(req, res));
	await new Promise<void>((resolve) => {
		sidecar.listen(0, () => {
			sidecarPort = (sidecar.address() as any).port;
			resolve();
		});
	});
});

afterAll(() => sidecar?.close());

// ── Helpers ─────────────────────────────────────────────────────

type RouteMap = Record<string, Record<string, Function>>;

function createMockRouter(): { routes: RouteMap; router: any } {
	const routes: RouteMap = {};
	const register = (method: string) => (path: string, fn: Function) => {
		routes[method] = routes[method] || {};
		routes[method][path] = fn;
	};
	return {
		routes,
		router: {
			get: register('GET'),
			post: register('POST'),
			put: register('PUT'),
			delete: register('DELETE'),
		},
	};
}

function mockReq(overrides: Record<string, any> = {}) {
	return {
		accountability: { admin: true, user: 'admin-id', roles: ['admin-role'] },
		body: {},
		params: {},
		...overrides,
	};
}

function mockRes() {
	const res: any = { _status: 0, _json: null, _headers: {} };
	res.status = (code: number) => { res._status = code; return res; };
	res.json = (data: any) => { res._json = data; return res; };
	res.setHeader = (k: string, v: string) => { res._headers[k] = v; };
	res.headersSent = false;
	return res;
}

function mockDb(policyExists: boolean) {
	const chain: any = {};
	chain.join = () => chain;
	chain.where = () => chain;
	chain.andWhere = (fn: Function) => { fn.call(chain); return chain; };
	chain.whereIn = () => chain;
	chain.orWhere = () => chain;
	chain.first = () => Promise.resolve(policyExists ? { id: 'policy-id' } : undefined);
	return () => chain;
}

// ── Auth: requireBackupAccess (tested via route handlers) ───────

describe('access control', () => {
	it('admin users get access', async () => {
		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const req = mockReq();
		const res = mockRes();
		await routes['GET']['/check-access'](req, res);
		expect(res._json).toEqual({ access: true });
	});

	it('non-admin without policy gets 403', async () => {
		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const req = mockReq({ accountability: { admin: false, user: 'user-id', roles: ['role-1'] } });
		const res = mockRes();
		await routes['GET']['/check-access'](req, res);
		expect(res._status).toBe(403);
	});

	it('non-admin with backup policy gets access', async () => {
		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
			database: mockDb(true),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const req = mockReq({ accountability: { admin: false, user: 'user-id', roles: ['role-1'] } });
		const res = mockRes();
		await routes['GET']['/check-access'](req, res);
		expect(res._json).toEqual({ access: true });
	});

	it('no accountability returns 403', async () => {
		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const req = mockReq({ accountability: undefined });
		const res = mockRes();
		await routes['GET']['/check-access'](req, res);
		expect(res._status).toBe(403);
	});
});

// ── Sidecar proxy ──────────────────────────────────────────

describe('sidecar proxy', () => {
	it('/list proxies to sidecar and returns result', async () => {
		sidecarHandler = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify([{ id: 'backup-1' }]));
		};

		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const res = mockRes();
		await routes['GET']['/list'](mockReq(), res);
		expect(res._status).toBe(200);
		expect(res._json).toEqual([{ id: 'backup-1' }]);
	});

	it('returns 503 when sidecar not configured', async () => {
		const { routes, router } = createMockRouter();
		handler(router, {
			env: {},
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const res = mockRes();
		await routes['GET']['/list'](mockReq(), res);
		expect(res._status).toBe(503);
		expect(res._json.error).toMatch(/not configured/i);
	});

	it('returns 502 when sidecar is unreachable', async () => {
		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: 'http://127.0.0.1:1', BACKUP_SECRET: 'test' },
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const res = mockRes();
		await routes['GET']['/list'](mockReq(), res);
		expect(res._status).toBe(502);
		expect(res._json.error).toMatch(/unreachable/i);
	});
});

// ── /create route ───────────────────────────────────────────────

describe('/create', () => {
	it('generates a backup ID with custom label', async () => {
		sidecarHandler = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ started: true }));
		};

		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const req = mockReq({ body: { label: 'pre-deploy' } });
		const res = mockRes();
		await routes['POST']['/create'](req, res);

		expect(res._status).toBe(202);
		expect(res._json.id).toMatch(/__pre-deploy$/);
	});

	it('falls back to "manual" for invalid label', async () => {
		sidecarHandler = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ started: true }));
		};

		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const req = mockReq({ body: { label: 'has spaces!' } });
		const res = mockRes();
		await routes['POST']['/create'](req, res);

		expect(res._status).toBe(202);
		expect(res._json.id).toMatch(/__manual$/);
	});

	it('falls back to "manual" when label is empty', async () => {
		sidecarHandler = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ started: true }));
		};

		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const req = mockReq({ body: {} });
		const res = mockRes();
		await routes['POST']['/create'](req, res);

		expect(res._status).toBe(202);
		expect(res._json.id).toMatch(/__manual$/);
	});
});

// ── /restore route ──────────────────────────────────────────────

describe('/:id/restore', () => {
	it('forwards restore request to sidecar', async () => {
		let receivedBody = '';
		sidecarHandler = (req, res) => {
			let data = '';
			req.on('data', (c) => (data += c));
			req.on('end', () => {
				receivedBody = data;
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ accepted: true, backupId: '2026-01-01__00-00-00__test' }));
			});
		};

		const { routes, router } = createMockRouter();
		handler(router, {
			env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
			database: mockDb(false),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		const req = mockReq({ params: { id: '2026-01-01__00-00-00__test' } });
		const res = mockRes();
		await routes['POST']['/:id/restore'](req, res);

		expect(res._status).toBe(200);
		expect(res._json.accepted).toBe(true);
		expect(JSON.parse(receivedBody)).toMatchObject({ backupId: '2026-01-01__00-00-00__test' });
	});
});

// ── Backup ID validation at the extension boundary ──────────────

describe('backup ID validation', () => {
	const invalidIds = ['../etc', 'foo/bar', 'bad id', '..', ''];
	const idRoutes: Array<[string, string]> = [
		['DELETE', '/:id'],
		['GET', '/:id/download'],
		['POST', '/:id/restore'],
	];

	for (const [method, path] of idRoutes) {
		for (const id of invalidIds) {
			it(`${method} ${path} rejects invalid id ${JSON.stringify(id)} with 400`, async () => {
				let sidecarCalled = false;
				sidecarHandler = (_req, res) => {
					sidecarCalled = true;
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end('{}');
				};

				const { routes, router } = createMockRouter();
				handler(router, {
					env: { BACKUP_URL: `http://127.0.0.1:${sidecarPort}`, BACKUP_SECRET: 'test' },
					database: mockDb(false),
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				});

				const req = mockReq({ params: { id } });
				const res = mockRes();
				await routes[method][path](req, res);

				expect(res._status).toBe(400);
				expect(res._json.error).toMatch(/invalid backup id/i);
				expect(sidecarCalled).toBe(false);
			});
		}
	}
});
