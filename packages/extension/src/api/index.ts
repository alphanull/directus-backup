/**
 * Backup API endpoint — auth proxy to the sidecar.
 * Every route authenticates the request via Directus accountability,
 * then forwards to the sidecar. No filesystem operations here.
 * @author  Frank Kudermann – alphanull
 * @version 0.9.0
 * @license AGPL-3.0-only
 */

import { request as httpRequest, type IncomingMessage } from 'http';
import type { Router } from 'express';
import { LABEL_RE, LABEL_MAX, BACKUP_POLICY_NAME } from '../shared/constants.js';
import { isValidBackupId } from '../shared/path.js';

interface EndpointContext {
    env: Record<string, string | undefined>
    database: any
    logger: any
}

interface AccountableRequest {
    accountability?: { admin?: boolean, user?: string | null, roles?: string[] }
    body?: Record<string, unknown>
    params: Record<string, string>
}

/**
 * Authorizes the request: admins pass, otherwise the Backup Access policy is checked.
 */
async function requireBackupAccess(
    req: AccountableRequest,
    res: import('express').Response,
    database: any
): Promise<boolean> {
    const acc = req.accountability;
    if (acc?.admin) return true;

    const userId = acc?.user ?? null;
    const roles = acc?.roles ?? [];

    if (!userId && roles.length === 0) {
        res.status(403).json({ error: 'Forbidden' });
        return false;
    }

    const query = database('directus_access')
        .join('directus_policies', 'directus_access.policy', 'directus_policies.id')
        .where('directus_policies.name', BACKUP_POLICY_NAME)
        .andWhere(function(this: any) {
            if (roles.length > 0) this.whereIn('directus_access.role', roles);
            if (userId) this.orWhere('directus_access.user', userId);
        })
        .first();

    if (!await query) {
        res.status(403).json({ error: 'Forbidden' });
        return false;
    }

    return true;
}

/**
 * Zero-pads a number to two digits.
 */
export function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/**
 * Builds a timestamped backup ID from a sanitized label.
 */
export function generateBackupId(label: string): string {
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `${date}__${time}__${label}`;
}

/** JSON proxy to the sidecar. */
function callSidecar(
    baseUrl: string,
    secret: string,
    method: string,
    path: string,
    payload?: string
): Promise<{ ok: boolean, status: number, body: Record<string, unknown> }> {
    return new Promise(resolve => {
        const url = new URL(baseUrl + path);
        const headers: Record<string, string> = {
            'X-Backup-Secret': secret
        };
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = String(Buffer.byteLength(payload));
        }

        const req = httpRequest(
            {
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname + (url.search || ''),
                method,
                headers,
                timeout: 15_000
            },
            resp => {
                let data = '';
                resp.on('data', (c: Buffer) => { data += c; });
                resp.on('end', () => {
                    let body: Record<string, unknown> = {};
                    try {
                        body = JSON.parse(data);
                    } catch {
                        /* empty */
                    }
                    const status = resp.statusCode ?? 500;
                    resolve({ ok: status >= 200 && status < 300, status, body });
                });
            }
        );

        req.on('error', () => resolve({ ok: false, status: 502, body: { error: 'Sidecar unreachable' } }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, status: 504, body: { error: 'Sidecar timeout' } });
        });
        if (payload) req.write(payload);
        req.end();
    });
}

/** Stream proxy: pipes request body to the sidecar, returns JSON response. */
// eslint-disable-next-line max-params -- mirrors the http.request option set; an options object would add indirection without value
function proxyStreamToSidecar(
    baseUrl: string,
    secret: string,
    method: string,
    path: string,
    incoming: NodeJS.ReadableStream,
    contentType = 'application/gzip'
): Promise<{ ok: boolean, status: number, body: Record<string, unknown> }> {
    return new Promise(resolve => {
        const url = new URL(baseUrl + path);
        const req = httpRequest(
            {
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname,
                method,
                headers: {
                    'X-Backup-Secret': secret,
                    'Content-Type': contentType,
                    'Transfer-Encoding': 'chunked'
                },
                timeout: 5 * 60_000
            },
            resp => {
                let data = '';
                resp.on('data', (c: Buffer) => { data += c; });
                resp.on('end', () => {
                    let body: Record<string, unknown> = {};
                    try {
                        body = JSON.parse(data);
                    } catch {
                        /* empty */
                    }
                    const status = resp.statusCode ?? 500;
                    resolve({ ok: status >= 200 && status < 300, status, body });
                });
            }
        );

        req.on('error', () => resolve({ ok: false, status: 502, body: { error: 'Sidecar unreachable' } }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, status: 504, body: { error: 'Sidecar timeout' } });
        });

        const { body } = incoming as unknown as { body?: Buffer };
        if (Buffer.isBuffer(body) && body.length > 0) {
            req.end(body);
        } else {
            incoming.pipe(req);
        }
    });
}

/** Stream proxy: pipes the sidecar response (binary) to the client. */
function proxyStreamFromSidecar(
    baseUrl: string,
    secret: string,
    path: string,
    clientRes: import('express').Response
): Promise<void> {
    return new Promise(resolve => {
        const url = new URL(baseUrl + path);
        const req = httpRequest(
            {
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname,
                method: 'GET',
                headers: { 'X-Backup-Secret': secret },
                timeout: 5 * 60_000
            },
            (resp: IncomingMessage) => {
                const status = resp.statusCode ?? 500;

                if (status >= 400) {
                    let data = '';
                    resp.on('data', (c: Buffer) => { data += c; });
                    resp.on('end', () => {
                        let body: Record<string, unknown> = {};
                        try {
                            body = JSON.parse(data);
                        } catch {
                            /* empty */
                        }
                        clientRes.status(status).json(body);
                        resolve();
                    });
                    return;
                }

                if (resp.headers['content-type']) clientRes.setHeader('Content-Type', resp.headers['content-type']);
                if (resp.headers['content-disposition']) clientRes.setHeader('Content-Disposition', resp.headers['content-disposition']);
                clientRes.status(status);
                resp.pipe(clientRes);
                resp.on('end', resolve);
            }
        );

        req.on('error', () => {
            if (!clientRes.headersSent) clientRes.status(502).json({ error: 'Sidecar unreachable' });
            resolve();
        });
        req.on('timeout', () => {
            req.destroy();
            if (!clientRes.headersSent) clientRes.status(504).json({ error: 'Sidecar timeout' });
            resolve();
        });
        req.end();
    });
}

/**
 * Rejects requests whose backup ID does not match the allowed pattern,
 * enforcing the same invariant as the sidecar at the extension boundary
 * (defense in depth; prevents raw IDs from reaching the proxied URL path).
 */
function ensureValidId(id: string, res: import('express').Response): boolean {
    if (isValidBackupId(id)) return true;
    res.status(400).json({ error: 'Invalid backup ID' });
    return false;
}

/**
 * Registers the backup-api routes; each authenticates before proxying to the sidecar.
 */
function handler(router: Router, context: EndpointContext) { // eslint-disable-line max-lines-per-function
    const env = { ...process.env, ...context.env };
    const sidecarUrl = env.BACKUP_URL;
    const secret = env.BACKUP_SECRET;
    const { database } = context;

    /**
     * Responds 503 when the sidecar URL or secret is not configured.
     */
    function ensureSidecar(res: import('express').Response): boolean {
        if (sidecarUrl && secret) return true;
        res.status(503).json({ error: 'Backup sidecar not configured' });
        return false;
    }

    // ── LIST ─────────────────────────────────────────────────
    router.get('/list', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;
        const result = await callSidecar(sidecarUrl!, secret!, 'GET', '/list');
        res.status(result.status).json(result.body);
    });

    // ── CREATE ───────────────────────────────────────────────
    router.post('/create', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const rawLabel = ((req as unknown as AccountableRequest).body?.label as string) ?? '';
        const label
            = typeof rawLabel === 'string' && rawLabel.length > 0 && LABEL_RE.test(rawLabel) && rawLabel.length <= LABEL_MAX
                ? rawLabel
                : 'manual';

        const backupId = generateBackupId(label);
        const scope = (req as unknown as AccountableRequest).body?.scope;
        const payload = JSON.stringify({
            backupId,
            source: 'manual',
            ...scope && typeof scope === 'object' ? { scope } : {}
        });
        const result = await callSidecar(sidecarUrl!, secret!, 'POST', '/run', payload);

        if (result.ok) {
            res.status(202).json({ id: backupId, startedAt: new Date().toISOString() });
        } else {
            res.status(result.status).json(result.body);
        }
    });

    // ── UPLOAD → Sidecar /import (stream proxy) ────────
    router.post('/upload', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const result = await proxyStreamToSidecar(
            sidecarUrl!, secret!, 'POST', '/import', req as unknown as NodeJS.ReadableStream
        );
        res.status(result.status).json(result.body);
    });

    // ── DELETE → Sidecar ───────────────────────────────
    router.delete('/:id', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const { id } = (req as unknown as AccountableRequest).params;
        if (!ensureValidId(id, res)) return;
        const result = await callSidecar(sidecarUrl!, secret!, 'DELETE', `/backup/${id}`);
        res.status(result.status).json(result.body);
    });

    // ── DOWNLOAD → Sidecar (stream proxy) ─────────────
    router.get('/:id/download', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const { id } = (req as unknown as AccountableRequest).params;
        if (!ensureValidId(id, res)) return;
        await proxyStreamFromSidecar(sidecarUrl!, secret!, `/backup/${id}/download`, res);
    });

    // ── RESTORE → Sidecar ─────────────────────────────
    router.post('/:id/restore', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const { id } = (req as unknown as AccountableRequest).params;
        if (!ensureValidId(id, res)) return;
        const scope = (req as unknown as AccountableRequest).body?.scope;
        const payload = JSON.stringify({
            backupId: id,
            ...scope && typeof scope === 'object' ? { scope } : {}
        });
        const result = await callSidecar(sidecarUrl!, secret!, 'POST', '/restore', payload);
        res.status(result.status).json(result.body);
    });

    // ── CANCEL → Sidecar ──────────────────────────────
    router.post('/:id/cancel', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const { id } = (req as unknown as AccountableRequest).params;
        if (!ensureValidId(id, res)) return;
        const result = await callSidecar(sidecarUrl!, secret!, 'POST', '/cancel', JSON.stringify({ backupId: id }));
        res.status(result.status).json(result.body);
    });

    // ── CONFIG (read) → Sidecar ───────────────────────
    router.get('/config', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const result = await callSidecar(sidecarUrl!, secret!, 'GET', '/config');
        res.status(result.status).json(result.body);
    });

    // ── CONFIG (write) → Sidecar ──────────────────────
    router.put('/config', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const body = (req as unknown as AccountableRequest).body ?? {};
        const payload = JSON.stringify(body);
        const result = await callSidecar(sidecarUrl!, secret!, 'PUT', '/config', payload);
        res.status(result.status).json(result.body);
    });

    // ── STORAGE → Sidecar ─────────────────────────────
    router.get('/storage', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const result = await callSidecar(sidecarUrl!, secret!, 'GET', '/storage');
        res.status(result.status).json(result.body);
    });

    // ── ACTIVITY → Sidecar ────────────────────────────
    router.get('/activity', async(req, res) => {
        if (!await requireBackupAccess(req as unknown as AccountableRequest, res, database)) return;
        if (!ensureSidecar(res)) return;

        const limit = (req as unknown as { query: Record<string, string> }).query?.limit || '50';
        const result = await callSidecar(sidecarUrl!, secret!, 'GET', `/activity?limit=${limit}`);
        res.status(result.status).json(result.body);
    });

    // ── ACCESS CHECK (lightweight, used by preRegisterCheck) ─
    router.get('/check-access', async(req, res) => {
        if (await requireBackupAccess(req as unknown as AccountableRequest, res, database)) {
            res.json({ access: true });
        }
    });
}

export default {
    id: 'backup-api',
    handler
};
