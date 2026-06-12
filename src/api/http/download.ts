/**
 * Backup download: streams a backup directory as a `.tar.gz`, holding the
 * per-backup lock for the duration of the stream.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import type { Response } from 'express';
import { config } from '../core/config.js';
import { readManifest } from '../storage/manifest.js';
import { acquireLock, releaseLock } from '../storage/locks.js';

/**
 * Streams a backup as a `.tar.gz` download, holding the per-backup lock for the stream.
 * @param id      Backup ID to download.
 * @param res     Express response.
 * @param logger  Directus logger.
 */
export async function handleDownload(id: string, res: Response, logger: any): Promise<void> {
    if (!config.exportEnabled) {
        res.status(403).json({ error: 'Backup export is disabled', code: 'EXPORT_DISABLED' });
        return;
    }

    const dir = resolvePath(config.backupDir, id);
    const manifest = await readManifest(dir);
    if (!manifest) {
        res.status(404).json({ error: 'Backup not found' }); return;
    }
    if (manifest.status === 'running') {
        res.status(409).json({ error: 'Cannot download running backup' }); return;
    }

    const locked = await acquireLock(id, { backupId: id, startedAt: new Date().toISOString(), operation: 'download' });
    if (!locked) {
        res.status(409).json({ error: 'Backup is in use by an active operation' }); return;
    }

    let released = false;
    const release = (): void => {
        if (released) return;
        released = true;
        releaseLock(id).catch(e => logger?.warn?.(`Download lock release failed for ${id}: ${(e as Error).message}`));
    };

    const tar = spawn('tar', ['czf', '-', '-C', config.backupDir, id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let downloadStarted = false;
    const sendHeaders = (): void => {
        if (res.headersSent) return;
        downloadStarted = true;
        res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="${id}.tar.gz"`
        });
    };
    tar.stdout.on('data', chunk => {
        sendHeaders();
        if (!res.write(chunk)) tar.stdout.pause();
    });
    res.on('drain', () => tar.stdout.resume());
    tar.stderr.on('data', c => logger?.error?.(`tar stderr: ${c.toString()}`));
    tar.on('error', e => {
        release();
        if (!res.headersSent) res.status(500).json({ error: 'Archive failed' });
        else if (downloadStarted) {
            logger?.error?.(`Archive failed after response started: ${(e as Error).message}`);
            res.destroy();
        }
    });
    tar.on('close', code => {
        release();
        if (code !== 0 && !res.headersSent) res.status(500).json({ error: 'Archive failed' });
        else if (code !== 0 && downloadStarted) {
            logger?.error?.(`Archive failed after response started (exit ${code})`);
            res.destroy();
        } else {
            sendHeaders();
            res.end();
        }
    });
    res.on('close', () => {
        if (tar.exitCode === null && !tar.killed) tar.kill();
        release();
    });
}
