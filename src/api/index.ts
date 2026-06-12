/**
 * Backup API endpoint — self-contained (no sidecar, no Docker socket).
 *
 * This module is the Directus endpoint entry: it initialises config + runtime,
 * runs the one-time startup recovery on the cluster primary, and mounts the
 * routes defined in {@link file://./http/routes.ts}. Every route authenticates
 * via Directus accountability. Backups spawn `backup.sh`; restores are armed in
 * {@link file://./restore/restore.ts} and executed by `restore.sh` after a
 * container restart.
 * @author  Frank Kudermann – alphanull
 * @version 0.10.0
 * @license AGPL-3.0-only
 */

import type { Router } from 'express';
import { initConfig } from './core/config.js';
import { setRuntime } from './core/runtime.js';
import { finalizePendingRestore } from './restore/reconcile.js';
import { recoverStaleLocks, reconcileRunningManifests, cleanStaleTmpFiles } from './recovery.js';
import { applySchedule, isSchedulerInstance } from './scheduler.js';
import { registerRoutes, type EndpointContext } from './http/routes.js';
import { getSanityReport } from './core/sanity.js';

let startupDone = false;

/**
 * Runs the one-time startup sequence on the primary worker: reconcile a pending
 * restore (the post-restart half of the restore lifecycle), recover stale
 * locks, reconcile running manifests, then arm the scheduler. Idempotent and
 * guarded so an extension reload does not run it twice.
 * @param logger  Directus logger.
 */
async function runStartup(logger: any): Promise<void> {
    if (startupDone) return;
    startupDone = true;
    try {
        const sanity = await getSanityReport(true);
        if (!sanity.ok) {
            const summary = sanity.issues
                .filter(i => i.severity === 'error')
                .map(i => i.message)
                .join('; ');
            logger?.warn?.(`Backup installation incomplete: ${summary}`);
        }
        await finalizePendingRestore();
        await recoverStaleLocks();
        await cleanStaleTmpFiles();
        await reconcileRunningManifests();
        await applySchedule(logger);
    } catch (e) {
        logger?.error?.(`Backup startup sequence failed: ${(e as Error).message}`);
    }
}

/**
 * Directus endpoint handler: initialises config + runtime, kicks off startup
 * recovery on the scheduler instance, and mounts the backup routes.
 * @param router   Express router for this endpoint.
 * @param context  Directus endpoint context.
 */
function handler(router: Router, context: EndpointContext): void {
    const { database, getSchema, services, logger } = context;

    initConfig({ ...process.env, ...context.env });
    setRuntime({ getSchema, services, database, logger });

    if (isSchedulerInstance()) {
        runStartup(logger).catch(e => logger?.error?.(`Backup startup error: ${(e as Error).message}`));
    }

    registerRoutes(router, context);
}

export default {
    id: 'backup-api',
    handler
};
