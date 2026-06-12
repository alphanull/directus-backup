/**
 * Cron scheduling for automatic backups, plus the cluster-instance guard that
 * keeps the scheduler and startup recovery on a single worker.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import cron from 'node-cron';
import { buildCronExpr } from './core/config.js';
import { readConfig } from './storage/config-store.js';
import { appendActivity } from './core/activity.js';
import { startBackup } from './backup/backup.js';
import { generateBackupId } from './http/validation.js';

let cronTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Reads the current schedule config and (re-)schedules the cron job. Safe to
 * call repeatedly; always cancels the previous job first. The caller guards
 * cluster duplication via {@link isSchedulerInstance}.
 * @param logger  Directus logger.
 */
export async function applySchedule(logger: any): Promise<void> {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }

    const cfg = await readConfig();
    const expr = buildCronExpr(cfg.schedule, cfg.scheduleMinute, cfg.scheduleHour);
    if (!expr) {
        logger?.info?.('Backup schedule: off');
        return;
    }

    cronTask = cron.schedule(expr, async() => {
        logger?.info?.('Cron triggered: starting scheduled backup');
        const id = generateBackupId('scheduled');
        const result = await startBackup(id, 'scheduled');
        if (!result.ok) {
            logger?.warn?.(`Scheduled backup failed to start: ${result.error}`);
            appendActivity({ action: 'backup_failed', backupId: id, source: 'scheduled', detail: result.error }).catch(() => {});
        }
    });

    logger?.info?.(`Backup schedule: ${cfg.schedule} (${expr})`);
}

/**
 * Whether this worker should own the scheduler and startup recovery. In PM2
 * cluster mode every worker gets a `NODE_APP_INSTANCE`; only instance `0` (or a
 * non-PM2 deployment, where it is undefined) runs them, so a scheduled backup
 * and the filesystem recovery never run on multiple workers at once.
 * @returns `true` if this worker owns the scheduler.
 */
export function isSchedulerInstance(): boolean {
    const inst = process.env.NODE_APP_INSTANCE;
    return inst === undefined || inst === '0';
}
