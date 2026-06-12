/**
 * Route wiring for the backup API. Every verb is wrapped once so an async
 * handler that rejects returns a clean 500 instead of hanging the client; each
 * route authenticates via {@link requireBackupAccess} before doing any work.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { resolve as resolvePath } from 'node:path';
import { rm } from 'node:fs/promises';
import type { Router, Response } from 'express';
import { LABEL_RE, LABEL_MAX } from '../../shared/constants.js';
import { config, DEFAULT_SCOPE, VALID_SCHEDULES, VALID_RETENTIONS } from '../core/config.js';
import { requireBackupAccess, type AccountableRequest } from './auth.js';
import { generateBackupId, validateBackupId, validateScopeInput, isEmptyComponentScope } from './validation.js';
import { handleImport } from './import.js';
import { handleDownload } from './download.js';
import { startBackup } from '../backup/backup.js';
import { cancelBackup } from '../backup/process.js';
import type { RunScope } from '../../shared/types.js';
import { requestRestore, scheduleContainerRestart } from '../restore/restore.js';
import { readConfig, writeConfig, type BackupConfig } from '../storage/config-store.js';
import { readManifest, readAllManifests } from '../storage/manifest.js';
import { acquireLock, releaseLock } from '../storage/locks.js';
import { dirSizeBytes, getFreeMB } from '../storage/space.js';
import { appendActivity, readActivity } from '../core/activity.js';
import { applySchedule, isSchedulerInstance } from '../scheduler.js';
import { getSanityReport } from '../core/sanity.js';

/** Directus endpoint context handed to the route registrar. */
export interface EndpointContext {
    env: Record<string, any>
    database: any
    getSchema: () => Promise<any>
    services: Record<string, any>
    logger: any
}

/**
 * Registers every backup route on the given router.
 * @param router   Express router for this endpoint.
 * @param context  Directus endpoint context (database + logger are used here).
 */
export function registerRoutes(router: Router, context: EndpointContext): void { // eslint-disable-line max-lines-per-function
    const { database, logger } = context;

    const auth = (req: any, res: Response): Promise<boolean> => requireBackupAccess(req as AccountableRequest, res, database);

    // Express 4 does not catch rejections from async route handlers — an
    // unhandled rejection leaves the request hanging with no response. Wrap
    // every verb once so any handler that throws/rejects returns a clean 500
    // instead of hanging the client (covers current and future routes).
    type AsyncHandler = (req: any, res: Response) => unknown;
    for (const verb of ['get', 'post', 'put', 'delete'] as const) {
        const original = (router[verb] as (path: string, h: (req: any, res: Response) => void) => unknown).bind(router);
        // Return the promise so awaiting callers (e.g. tests) see completion;
        // Express ignores the return value at runtime.
        (router as unknown as Record<string, unknown>)[verb] = (path: string, h: AsyncHandler): unknown => original(path, (req, res) => Promise.resolve(h(req, res)).catch((err: unknown) => {
            logger?.error?.(`Unhandled error in ${req.method} ${path}: ${(err as Error).message}`);
            if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
        }));
    }

    // ── LIST ──
    router.get('/list', async(req, res) => {
        if (!await auth(req, res)) return;
        const manifests = await readAllManifests();
        manifests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        res.status(200).json(manifests);
    });

    // ── CREATE ──
    router.post('/create', async(req, res) => {
        if (!await auth(req, res)) return;
        const body = (req as AccountableRequest).body ?? {};
        const rawLabel = (body.label as string) ?? '';
        const label = typeof rawLabel === 'string' && rawLabel.length > 0 && LABEL_RE.test(rawLabel) && rawLabel.length <= LABEL_MAX
            ? rawLabel
            : 'manual';

        let scopeOverride: { database: boolean, assets: boolean, extensions: boolean, includeCollections?: string[], excludedCollections?: string[] } | undefined;
        if (body.scope !== undefined) {
            const r = validateScopeInput(body.scope);
            if (!r.ok) {
                res.status(400).json({ error: `scope: ${r.error}` }); return;
            }
            scopeOverride = { ...DEFAULT_SCOPE, ...r.value };
            if (isEmptyComponentScope(scopeOverride)) {
                res.status(400).json({ error: 'scope must include at least one component (database, assets, or extensions)' });
                return;
            }
        }

        const backupId = generateBackupId(label);
        const result = await startBackup(backupId, 'manual', scopeOverride);
        if (result.ok) {
            res.status(202).json({ id: backupId, startedAt: new Date().toISOString() });
        } else {
            res.status(result.status).json({ error: result.error, code: result.code });
        }
    });

    // ── UPLOAD (import) ──
    router.post('/upload', async(req, res) => {
        if (!await auth(req, res)) return;
        await handleImport(req, res);
    });

    // ── RESTORE ──
    router.post('/:id/restore', async(req, res) => {
        if (!await auth(req, res)) return;
        const { id } = (req as AccountableRequest).params;
        if (!validateBackupId(id, res)) return;

        let requestScope: RunScope | undefined;
        const scope = (req as AccountableRequest).body?.scope;
        if (scope !== undefined) {
            const r = validateScopeInput(scope);
            if (!r.ok) {
                res.status(400).json({ error: `scope: ${r.error}` }); return;
            }
            requestScope = {
                database: typeof r.value.database === 'boolean' ? r.value.database : DEFAULT_SCOPE.database,
                assets: typeof r.value.assets === 'boolean' ? r.value.assets : DEFAULT_SCOPE.assets,
                extensions: typeof r.value.extensions === 'boolean' ? r.value.extensions : DEFAULT_SCOPE.extensions,
                includeCollections: r.value.includeCollections || []
            };
            if (isEmptyComponentScope(requestScope)) {
                res.status(400).json({ error: 'scope must include at least one component (database, assets, or extensions)' });
                return;
            }
        }

        const backupPath = resolvePath(config.backupDir, id);
        const manifest = await readManifest(backupPath);
        if (!manifest) {
            res.status(404).json({ error: 'Backup not found' }); return;
        }
        if (manifest.status !== 'success') {
            res.status(409).json({ error: 'Backup not in success state' }); return;
        }

        const result = await requestRestore(id, manifest, backupPath, requestScope);
        if (result.ok) {
            res.status(202).json({ accepted: true, backupId: id });
            // Arm the restart only after the response is on its way; the actual
            // restore runs on the next boot via restore.sh.
            scheduleContainerRestart(id);
        } else {
            res.status(result.status).json({ error: result.error, code: result.code });
        }
    });

    // ── CANCEL ──
    router.post('/:id/cancel', async(req, res) => {
        if (!await auth(req, res)) return;
        const { id } = (req as AccountableRequest).params;
        if (!validateBackupId(id, res)) return;

        const manifest = await readManifest(resolvePath(config.backupDir, id));
        if (!manifest) {
            res.status(404).json({ error: 'Backup not found' }); return;
        }
        if (manifest.status !== 'running') {
            res.status(409).json({ error: 'Backup is not running' }); return;
        }

        if (!cancelBackup(id)) {
            res.status(409).json({ error: 'Backup process not found — may have just finished' }); return;
        }
        res.status(202).json({ accepted: true, backupId: id });
    });

    // ── DOWNLOAD ──
    router.get('/:id/download', async(req, res) => {
        if (!await auth(req, res)) return;
        const { id } = (req as AccountableRequest).params;
        if (!validateBackupId(id, res)) return;
        await handleDownload(id, res, logger);
    });

    // ── DELETE ──
    router.delete('/:id', async(req, res) => {
        if (!await auth(req, res)) return;
        const { id } = (req as AccountableRequest).params;
        if (!validateBackupId(id, res)) return;

        const dir = resolvePath(config.backupDir, id);
        const manifest = await readManifest(dir);
        if (!manifest) {
            res.status(404).json({ error: 'Backup not found' }); return;
        }
        if (manifest.status === 'running') {
            res.status(409).json({ error: 'Cannot delete running backup' }); return;
        }

        const locked = await acquireLock(id, { backupId: id, startedAt: new Date().toISOString(), operation: 'delete' });
        if (!locked) {
            res.status(409).json({ error: 'Backup is in use by an active operation' }); return;
        }

        try {
            await rm(dir, { recursive: true });
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                res.status(404).json({ error: 'Backup not found' }); return;
            }
            throw e;
        } finally {
            await releaseLock(id);
        }

        appendActivity({ action: 'delete', backupId: id }).catch(() => {});
        res.status(200).json({ success: true });
    });

    // ── CONFIG (read) ──
    router.get('/config', async(req, res) => {
        if (!await auth(req, res)) return;
        res.status(200).json({ ...await readConfig(), importEnabled: config.importEnabled, exportEnabled: config.exportEnabled });
    });

    // ── CONFIG (write) ──
    router.put('/config', async(req, res) => {
        if (!await auth(req, res)) return;
        const body = (req as AccountableRequest).body ?? {};
        const cfg: BackupConfig = await readConfig();

        if (body.schedule !== undefined) {
            if (!VALID_SCHEDULES.includes(body.schedule as string)) {
                res.status(400).json({ error: `Invalid schedule. Valid: ${VALID_SCHEDULES.join(', ')}` }); return;
            }
            cfg.schedule = body.schedule as string;
        }
        if (body.scheduleMinute !== undefined) {
            const v = Math.floor(Number(body.scheduleMinute));
            if (!Number.isFinite(v) || v < 0 || v > 59) {
                res.status(400).json({ error: 'scheduleMinute must be 0–59' }); return;
            }
            cfg.scheduleMinute = v;
        }
        if (body.scheduleHour !== undefined) {
            const v = Math.floor(Number(body.scheduleHour));
            if (!Number.isFinite(v) || v < 0 || v > 23) {
                res.status(400).json({ error: 'scheduleHour must be 0–23' }); return;
            }
            cfg.scheduleHour = v;
        }
        if (body.retention !== undefined) {
            if (!VALID_RETENTIONS.includes(body.retention as string)) {
                res.status(400).json({ error: `Invalid retention. Valid: ${VALID_RETENTIONS.join(', ')}` }); return;
            }
            cfg.retention = body.retention as string;
        }
        if (body.quotaMB !== undefined) {
            const v = Number(body.quotaMB);
            if (!Number.isFinite(v) || v < 0) {
                res.status(400).json({ error: 'quotaMB must be >= 0' }); return;
            }
            cfg.quotaMB = v;
        }
        if (body.minFreeMB !== undefined) {
            const v = Number(body.minFreeMB);
            if (!Number.isFinite(v) || v < 0) {
                res.status(400).json({ error: 'minFreeMB must be >= 0' }); return;
            }
            cfg.minFreeMB = v;
        }
        if (body.backupScope !== undefined) {
            const r = validateScopeInput(body.backupScope);
            if (!r.ok) {
                res.status(400).json({ error: `backupScope: ${r.error}` }); return;
            }
            const merged = { ...cfg.backupScope || { ...DEFAULT_SCOPE }, ...r.value };
            if (isEmptyComponentScope(merged)) {
                res.status(400).json({ error: 'backupScope must include at least one component (database, assets, or extensions)' }); return;
            }
            cfg.backupScope = merged;
        }

        await writeConfig(cfg);
        if (isSchedulerInstance()) await applySchedule(logger);
        appendActivity({ action: 'config' }).catch(() => {});
        res.status(200).json(cfg);
    });

    // ── STORAGE ──
    router.get('/storage', async(req, res) => {
        if (!await auth(req, res)) return;
        const cfg = await readConfig();
        const freeMB = getFreeMB();
        let usedMB: number | null = null;
        try {
            usedMB = Math.round(await dirSizeBytes(config.backupDir) / (1024 * 1024));
        } catch (e) {
            logger?.warn?.(`Backup size check failed: ${(e as Error).message}`);
        }
        res.status(200).json({ usedMB, freeMB, quotaMB: cfg.quotaMB, minFreeMB: cfg.minFreeMB });
    });

    // ── ACTIVITY ──
    router.get('/activity', async(req, res) => {
        if (!await auth(req, res)) return;
        const limit = parseInt((req as AccountableRequest).query?.limit || '100', 10);
        res.status(200).json(await readActivity(Math.min(Math.max(limit, 1), 100)));
    });

    // ── ACCESS CHECK ──
    router.get('/check-access', async(req, res) => {
        if (await auth(req, res)) res.json({ access: true });
    });

    // ── INSTALLATION HEALTH ──
    router.get('/health', async(req, res) => {
        if (!await auth(req, res)) return;
        res.status(200).json(await getSanityReport());
    });
}
