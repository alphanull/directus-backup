/**
 * Backup import: accepts an uploaded `.tar.gz`, validates archive integrity
 * (symlinks, device files, path traversal), bounds disk usage, extracts, and
 * verifies the manifest before accepting. Never touches the live database.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { resolve as resolvePath, join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { stat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { Response } from 'express';
import { config, BACKUP_ID_RE, COLLECTION_NAME_RE, UPLOAD_TMP_PREFIX } from '../core/config.js';
import { readConfig } from '../storage/config-store.js';
import { readManifest } from '../storage/manifest.js';
import { acquireLock, releaseLock } from '../storage/locks.js';
import { dirSizeBytes, checkQuota, getFreeMB, uploadBudget } from '../storage/space.js';
import { appendActivity } from '../core/activity.js';
import { getSanityReport, installationError } from '../core/sanity.js';

/** Prefix for the temporary upload file written before validation. */
const TMP_PREFIX = UPLOAD_TMP_PREFIX;

/** Lists an archive (tar tvzf) and returns stdout, or throws on non-zero exit. */
function tarList(archivePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const proc = spawn('tar', ['tvzf', archivePath]);
        let out = '';
        proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
        proc.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`Cannot list archive (code=${code})`))));
        proc.on('error', reject);
    });
}

/**
 * Validates a `tar tvzf` listing: no symlinks, hard links, device/special files,
 * or path traversal. Returns an error message, or null if clean.
 */
function validateTarListing(listing: string): string | null {
    for (const entry of listing.trim().split('\n').filter(Boolean)) {
        const parts = entry.trim().split(/\s+/);
        if (parts.length < 6) continue;
        const permissions = parts[0];
        const rawFilename = parts.slice(5).join(' ');
        const filename = rawFilename.split(' -> ')[0];
        if (permissions[0] === 'l') return 'Archive contains symlinks (security risk)';
        if (permissions[0] === 'h') return 'Archive contains hard links (security risk)';
        if (rawFilename.includes(' -> ')) return 'Archive contains hard links (security risk)';
        if ('bcps'.includes(permissions[0])) return 'Archive contains device files, pipes, or sockets (security risk)';
        if (filename.startsWith('/') || filename.includes('..')) return 'Archive contains unsafe paths';
    }
    return null;
}

/**
 * Imports a backup from an uploaded `.tar.gz` archive. Validates archive
 * integrity (symlinks, device files, path traversal), bounds disk usage twice
 * (streaming byte budget + uncompressed-size check), extracts, and verifies the
 * manifest before accepting. Holds the per-backup lock for the existence check
 * and extraction. Does not touch the live database (no `LIVE_DB` lock).
 * @param req  The Directus request (raw upload body stream).
 * @param res  Express response.
 */
export async function handleImport(req: any, res: Response): Promise<void> { // eslint-disable-line max-lines-per-function, max-statements
    if (!config.importEnabled) {
        res.status(403).json({ error: 'Backup import is disabled', code: 'IMPORT_DISABLED' });
        return;
    }

    const sanity = await getSanityReport();
    if (!sanity.operational) {
        res.status(503).json({
            error: installationError(sanity),
            code: 'INSTALL_INCOMPLETE',
            issues: sanity.issues.filter(i => i.severity === 'error')
        });
        return;
    }

    const tmpFile = join(config.backupDir, `${TMP_PREFIX}${Date.now()}.tar.gz`);
    let extractedId: string | null = null;
    let lockedId: string | null = null;

    try {
        const cfg = await readConfig();
        const freeMB = getFreeMB();
        const { ok: spaceOk, budgetBytes: rawBudget } = uploadBudget(freeMB, cfg.minFreeMB);
        if (!spaceOk) {
            res.status(507).json({ error: `Storage limit reached: free space ${freeMB}MB <= min ${cfg.minFreeMB}MB`, code: 'DISK_FULL', freeMB, minFreeMB: cfg.minFreeMB });
            return;
        }

        // df failed: derive a streaming cap from quotaMB so the upload cannot
        // silently fill the disk. minFreeMB remains unenforced when df is unavailable.
        let budgetBytes = rawBudget;
        if (budgetBytes === null && cfg.quotaMB > 0) {
            try {
                const usedMB = Math.round(await dirSizeBytes(config.backupDir) / (1024 * 1024));
                const remainingMB = cfg.quotaMB - usedMB;
                if (remainingMB <= 0) {
                    res.status(507).json({ error: `Quota already reached: used ${usedMB}MB >= quota ${cfg.quotaMB}MB`, code: 'QUOTA_EXCEEDED', usedMB, quotaMB: cfg.quotaMB });
                    return;
                }
                budgetBytes = remainingMB * 1024 * 1024;
            } catch { /* dirSizeBytes failed; streaming remains uncapped */ }
        }

        await new Promise<void>((resolve, reject) => {
            const ws = createWriteStream(tmpFile);
            let written = 0;
            let aborted = false;
            ws.on('error', reject);
            ws.on('finish', () => resolve());
            req.on('data', (chunk: Buffer) => {
                if (aborted) return;
                written += chunk.length;
                if (budgetBytes !== null && written > budgetBytes) {
                    aborted = true;
                    req.unpipe(ws);
                    ws.destroy();
                    if (!res.headersSent) res.status(507).json({ error: 'Upload exceeds available storage' });
                    req.destroy();
                    reject(new Error('Upload exceeds available storage'));
                }
            });
            req.pipe(ws);
        });

        const tmpStat = await stat(tmpFile);
        if (tmpStat.size === 0) {
            res.status(400).json({ error: 'Empty upload' });
            return;
        }

        const listing = await new Promise<string>((resolve, reject) => {
            const proc = spawn('tar', ['tvzf', tmpFile]);
            let out = '';
            proc.stdout.on('data', c => { out += c.toString(); });
            proc.on('close', code => (code === 0 ? resolve(out) : reject(new Error('Invalid or corrupted archive'))));
            proc.on('error', reject);
        });

        const entries = listing.trim().split('\n').filter(Boolean);
        if (entries.length === 0) {
            res.status(400).json({ error: 'Archive is empty' });
            return;
        }

        const topLevelDirs = new Set<string>();
        let extractedBytes = 0;
        for (const entry of entries) {
            const parts = entry.trim().split(/\s+/);
            if (parts.length < 6) continue;
            const permissions = parts[0];
            const rawFilename = parts.slice(5).join(' ');
            const filename = rawFilename.split(' -> ')[0];
            if (permissions[0] === 'l') {
                res.status(400).json({ error: 'Archive contains symlinks (security risk)' }); return;
            }
            if (permissions[0] === 'h') {
                res.status(400).json({ error: 'Archive contains hard links (security risk)' }); return;
            }
            if (rawFilename.includes(' -> ')) {
                res.status(400).json({ error: 'Archive contains hard links (security risk)' }); return;
            }
            if ('bcps'.includes(permissions[0])) {
                res.status(400).json({ error: 'Archive contains device files, pipes, or sockets (security risk)' }); return;
            }
            if (filename.startsWith('/') || filename.includes('..')) {
                res.status(400).json({ error: 'Archive contains unsafe paths' }); return;
            }
            const size = Number.parseInt(parts[2], 10);
            if (Number.isFinite(size)) extractedBytes += size;
            const top = filename.split('/')[0];
            if (top) topLevelDirs.add(top);
        }

        if (topLevelDirs.size !== 1) {
            res.status(400).json({ error: 'Archive must contain exactly one backup directory' }); return;
        }

        const extractBudget = uploadBudget(getFreeMB(), cfg.minFreeMB);
        if (!extractBudget.ok) {
            res.status(507).json({ error: 'Storage limit reached before extraction' }); return;
        }
        if (extractBudget.budgetBytes !== null && extractedBytes > extractBudget.budgetBytes) {
            res.status(507).json({ error: `Extracted size ~${Math.round(extractedBytes / (1024 * 1024))}MB exceeds available storage` });
            return;
        }

        if (cfg.quotaMB > 0) {
            let currentUsedMB: number | null = null;
            try {
                currentUsedMB = Math.round(await dirSizeBytes(config.backupDir) / (1024 * 1024));
            } catch { /* skip check if size measurement fails */ }
            if (currentUsedMB !== null) {
                const importMB = Math.round(extractedBytes / (1024 * 1024));
                if (currentUsedMB + importMB > cfg.quotaMB) {
                    res.status(507).json({
                        error: `Quota would be exceeded: current ${currentUsedMB}MB + import ~${importMB}MB > quota ${cfg.quotaMB}MB`,
                        code: 'QUOTA_IMPORT_EXCEEDED',
                        usedMB: currentUsedMB,
                        importMB,
                        quotaMB: cfg.quotaMB
                    });
                    return;
                }
            }
        }

        const backupId = [...topLevelDirs][0];
        if (!BACKUP_ID_RE.test(backupId)) {
            res.status(400).json({ error: 'Archive directory name is not a valid backup ID' }); return;
        }

        const targetDir = resolvePath(config.backupDir, backupId);
        if (!targetDir.startsWith(`${resolvePath(config.backupDir)}/`)) {
            res.status(400).json({ error: 'Invalid backup ID in archive' }); return;
        }

        if (!await acquireLock(backupId, { backupId, startedAt: new Date().toISOString(), operation: 'import' })) {
            res.status(409).json({ error: 'Backup is in use by an active operation' });
            return;
        }
        lockedId = backupId;

        try {
            await stat(targetDir);
            res.status(409).json({ error: `Backup ${backupId} already exists` });
            return;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }

        extractedId = backupId;

        await new Promise<void>((resolve, reject) => {
            const proc = spawn('tar', ['xzf', tmpFile, '-C', config.backupDir, '-o', '--no-same-permissions', '-h']);
            proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`tar extract failed (code=${code})`))));
            proc.on('error', reject);
        });

        try { await rm(tmpFile, { force: true }); } catch { /* ignore */ }

        const manifest = await readManifest(targetDir);

        const rejectExtracted = async(status: number, body: Record<string, unknown>): Promise<void> => {
            try { await rm(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
            extractedId = null;
            res.status(status).json(body);
        };

        if (!manifest) return rejectExtracted(400, { error: 'Archive does not contain a valid backup manifest' });
        if (manifest.id !== backupId) return rejectExtracted(400, { error: 'Archive manifest id does not match the archive directory name' });
        if (manifest.status !== 'success') return rejectExtracted(409, { error: `Backup has status "${String(manifest.status)}", only successful backups can be imported` });

        const scope = (manifest.scope || {}) as { database?: boolean, assets?: boolean, extensions?: boolean, includedCollections?: unknown };

        // A foreign manifest's includedCollections flows into RESTORE_INCLUDE_TABLES
        // on restore; reject anything that is not a strict collection name so it
        // can never reach the restore flag file as an injection payload.
        if (scope.includedCollections !== undefined) {
            const list = scope.includedCollections;
            if (!Array.isArray(list) || list.some(v => typeof v !== 'string' || !COLLECTION_NAME_RE.test(v))) {
                return rejectExtracted(400, { error: 'Archive manifest contains an invalid collection name in scope.includedCollections' });
            }
        }

        const requiredFiles: Array<[boolean, string]> = [
            [scope.database !== false, 'database.dump'],
            [scope.assets !== false, 'uploads.tar.gz'],
            [scope.extensions !== false, 'extensions.tar.gz']
        ];
        for (const [included, file] of requiredFiles) {
            if (!included) continue;
            const innerPath = join(targetDir, file);
            try {
                await stat(innerPath);
            } catch {
                return rejectExtracted(400, { error: `Archive manifest declares a component the archive does not contain: ${file} is missing` });
            }
            if (file.endsWith('.tar.gz')) {
                try {
                    const innerErr = validateTarListing(await tarList(innerPath));
                    if (innerErr) return rejectExtracted(400, { error: `${file} failed security validation: ${innerErr}` });
                } catch {
                    return rejectExtracted(400, { error: `${file} could not be read or decompressed` });
                }
            }
        }

        const quota = await checkQuota();
        if (!quota.ok) {
            const first = quota.reasons[0];
            return rejectExtracted(507, { ...first, error: quota.reasons.map(r => r.text).join('; ') });
        }

        extractedId = null;
        appendActivity({ action: 'upload', backupId }).catch(() => {});
        res.status(200).json(manifest);
    } catch (e) {
        const msg = (e as Error).message || 'Upload failed';
        if (!res.headersSent) res.status(400).json({ error: msg });
    } finally {
        try { await rm(tmpFile, { force: true }); } catch { /* ignore */ }
        if (extractedId) {
            const dir = resolvePath(config.backupDir, extractedId);
            try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        if (lockedId) await releaseLock(lockedId);
    }
}
