/**
 * HTTP server, cron scheduling, and request handlers.
 * Startup sequence: discoverDirectus → recoverStaleLocks → reconcileRunningManifests → applySchedule → listen.
 * @author  Frank Kudermann – alphanull
 * @version 0.9.0
 * @license AGPL-3.0-only
 */

import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { spawn } from 'node:child_process';
import { stat, rm } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { PORT, SECRET, BACKUP_DIR, BACKUP_ID_RE, COLLECTION_NAME_RE, LIVE_DB, buildCronExpr, VALID_SCHEDULES, VALID_RETENTIONS, DEFAULT_SCOPE, IMPORT_ENABLED, EXPORT_ENABLED } from './lib/config.js';
import { discoverDirectus, recoverStaleLocks, reconcileRunningManifests, startBackup, doRestore, cancelBackup } from './lib/runner.js';
import { readConfig, writeConfig, readManifest, readAllManifests, acquireLock, releaseLock, dirSizeBytes, checkQuota, getFreeMB, uploadBudget } from './lib/storage.js';
import { appendActivity, readActivity } from './lib/activity.js';

// ── ID generation ─────────────────────────────────────────────

/**
 * Zero-pads a number to two digits.
 * @param   {number} n  Number to pad.
 * @returns {string}    The two-digit, zero-padded value.
 */
function pad(n) {
    return String(n).padStart(2, '0');
}

/**
 * Generates a timestamped backup ID: `YYYY-MM-DD__HH-MM-SS__<label>`.
 * @param   {string} label  Human-readable label suffix.
 * @returns {string}        The generated backup ID.
 */
function generateBackupId(label) {
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `${date}__${time}__${label}`;
}

// ── HTTP utilities ────────────────────────────────────────────

/**
 * Sends a JSON response with the given status code.
 * @param {import('node:http').ServerResponse} res     The HTTP response.
 * @param {number}                             status  HTTP status code.
 * @param {unknown}                            body    JSON-serialisable response body.
 */
function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * Maximum accepted size (bytes) for a JSON request body. The JSON endpoints
 * (/run, /config, /restore) carry small payloads; this cap bounds the memory an
 * authenticated caller can force the sidecar to buffer. The /import upload path
 * does not use this — it streams to disk under its own free-space budget.
 */
const MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * Reads the full request body as a string, aborting once it exceeds
 * {@link MAX_JSON_BODY_BYTES}. Throwing out of the `for await` loop closes the
 * async iterator, which destroys the underlying stream.
 * @param   {import('node:http').IncomingMessage} req  The incoming HTTP request.
 * @returns {Promise<string>}                          The full request body as a string.
 * @throws  {Error & { code?: string }}                `code: 'BODY_TOO_LARGE'` if the limit is exceeded.
 */
async function collectBody(req) {
    let raw = '';
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_JSON_BODY_BYTES) {
            const err = /** @type {Error & { code?: string }} */ (new Error('Request body too large'));
            err.code = 'BODY_TOO_LARGE';
            throw err;
        }
        raw += chunk;
    }
    return raw;
}

/**
 * Validates the `X-Backup-Secret` header against the configured secret.
 * Uses a constant-time comparison over fixed-length SHA-256 digests so the
 * check leaks neither the secret's content nor its length via timing.
 * @param   {import('node:http').IncomingMessage} req  The incoming HTTP request.
 * @returns {boolean}                                  `true` if the header matches the configured secret.
 */
function checkSecret(req) {
    const provided = req.headers['x-backup-secret'];
    if (typeof provided !== 'string') return false;
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(/** @type {string} */ (SECRET)).digest();
    return timingSafeEqual(a, b);
}

/**
 * Parses the request body as JSON. Returns the parsed object, or sends a
 * 400 response and returns `null` on failure.
 * @template T
 * @param   {import('node:http').IncomingMessage} req  The incoming HTTP request.
 * @param   {import('node:http').ServerResponse}  res  The HTTP response.
 * @returns {Promise<T|null>}                          The parsed body, or `null` if invalid (a 400 was already sent).
 */
async function parseJsonBody(req, res) {
    let raw;
    try {
        raw = await collectBody(req);
    } catch (e) {
        if (/** @type {Error & { code?: string }} */ (e).code === 'BODY_TOO_LARGE') {
            send(res, 413, { error: 'Request body too large' });
        } else {
            send(res, 400, { error: 'Invalid JSON' });
        }
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch {
        send(res, 400, { error: 'Invalid JSON' });
        return null;
    }
}

/**
 * Validates a backup ID string and the corresponding path.
 * Sends a 400 response and returns `false` if invalid.
 * @param   {string|undefined}                   backupId  Backup ID to validate.
 * @param   {import('node:http').ServerResponse} res       The HTTP response.
 * @returns {boolean}                                      `true` if the ID is valid; otherwise a 400 was sent and `false` is returned.
 */
function validateBackupId(backupId, res) {
    if (!backupId || !BACKUP_ID_RE.test(backupId)) {
        send(res, 400, { error: 'Invalid backupId' });
        return false;
    }
    const backupPath = resolvePath(BACKUP_DIR, backupId);
    if (!backupPath.startsWith(`${resolvePath(BACKUP_DIR)}/`)) {
        send(res, 400, { error: 'Invalid backupId' });
        return false;
    }
    return true;
}

/**
 * Validates a raw scope object. Each field is optional; only provided fields are
 * type-checked and returned, so the result can be merged onto an existing scope
 * (config update) or onto {@link DEFAULT_SCOPE} (per-run override).
 * @param   {unknown}                                                                                                                                                                               input  Raw scope value from a request body.
 * @returns {{ ok: true, value: Partial<{ database: boolean, assets: boolean, extensions: boolean, includeCollections: string[], excludedCollections: string[] }> } | { ok: false, error: string }}        Validation result.
 */
function validateScopeInput(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'scope must be an object' };
    const s = /** @type {Record<string, unknown>} */ (input);
    /** @type {Partial<{ database: boolean, assets: boolean, extensions: boolean, includeCollections: string[], excludedCollections: string[] }>} */
    const out = {};
    if (s.database !== undefined) out.database = Boolean(s.database);
    if (s.assets !== undefined) out.assets = Boolean(s.assets);
    if (s.extensions !== undefined) out.extensions = Boolean(s.extensions);
    if (s.includeCollections !== undefined) {
        if (!Array.isArray(s.includeCollections) || /** @type {unknown[]} */ (s.includeCollections).some(v => typeof v !== 'string')) {
            return { ok: false, error: 'scope.includeCollections must be an array of strings' };
        }
        // Names flow into SQL identifiers and shell word lists downstream; reject
        // anything outside the plain-identifier allowlist at the trust boundary.
        if (/** @type {string[]} */ (s.includeCollections).some(v => !COLLECTION_NAME_RE.test(v))) {
            return { ok: false, error: 'scope.includeCollections contains an invalid collection name' };
        }
        out.includeCollections = /** @type {string[]} */ (s.includeCollections);
    }
    if (s.excludedCollections !== undefined) {
        if (!Array.isArray(s.excludedCollections) || /** @type {unknown[]} */ (s.excludedCollections).some(v => typeof v !== 'string')) {
            return { ok: false, error: 'scope.excludedCollections must be an array of strings' };
        }
        if (/** @type {string[]} */ (s.excludedCollections).some(v => !COLLECTION_NAME_RE.test(v))) {
            return { ok: false, error: 'scope.excludedCollections contains an invalid collection name' };
        }
        out.excludedCollections = /** @type {string[]} */ (s.excludedCollections);
    }
    return { ok: true, value: out };
}

/**
 * Returns `true` if a scope would produce an empty backup, i.e. None of the
 * three components is selected. `includeCollections` is irrelevant here: it only
 * narrows the database dump and means nothing when `database` itself is off.
 * @param   {{ database?: boolean, assets?: boolean, extensions?: boolean }} scope  Effective scope to check.
 * @returns {boolean}                                                               `true` if no component is selected.
 */
function isEmptyComponentScope(scope) {
    return !scope.database && !scope.assets && !scope.extensions;
}

/** @typedef {import('node:http').IncomingMessage} Req */
/** @typedef {import('node:http').ServerResponse}  Res */

// ── Request handlers ──────────────────────────────────────────

/**
 * Starts a new backup. Expects `{ backupId, source }` in the request body.
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleRun(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });

    const body = await parseJsonBody(req, res);
    if (!body) return;

    const { backupId, source, scope } = body;
    if (!validateBackupId(backupId, res)) return;

    let scopeOverride;
    if (scope !== undefined) {
        const r = validateScopeInput(scope);
        if (!r.ok) return send(res, 400, { error: `scope: ${r.error}` });
        scopeOverride = { ...DEFAULT_SCOPE, ...r.value };
        if (isEmptyComponentScope(scopeOverride)) {
            return send(res, 400, { error: 'scope must include at least one component (database, assets, or extensions)' });
        }
    }

    const result = await startBackup(backupId, source || 'manual', scopeOverride);
    if (result.ok) {
        send(res, 202, { accepted: true, backupId });
    } else {
        const { ...rest } = result;
        send(res, result.status, rest);
    }
}

/**
 * Cancels a running backup by sending SIGTERM to its process group.
 * Responds 202 immediately; the actual cleanup (directory removal, lock
 * release) happens asynchronously inside monitorProcess() once the child
 * exits. Returns 409 when the backup is not currently running or its
 * process is no longer registered (for example, it just finished on its own).
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleCancel(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });

    const body = await parseJsonBody(req, res);
    if (!body) return;

    const { backupId } = body;
    if (!validateBackupId(backupId, res)) return;

    const manifest = await readManifest(resolvePath(BACKUP_DIR, backupId));
    if (!manifest) return send(res, 404, { error: 'Backup not found' });
    if (manifest.status !== 'running') return send(res, 409, { error: 'Backup is not running' });

    const killed = cancelBackup(backupId);
    if (!killed) return send(res, 409, { error: 'Backup process not found — may have just finished' });

    send(res, 202, { accepted: true, backupId });
}

/**
 * Returns the current schedule/retention/quota/scope config.
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleGetConfig(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });
    send(res, 200, { ...await readConfig(), importEnabled: IMPORT_ENABLED, exportEnabled: EXPORT_ENABLED });
}

/**
 * Updates the backup config (schedule, retention, quota, scope).
 * Validates each field individually and re-applies the cron schedule on success.
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handlePutConfig(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });

    const body = await parseJsonBody(req, res);
    if (!body) return;

    const cfg = await readConfig();

    if (body.schedule !== undefined) {
        if (!VALID_SCHEDULES.includes(body.schedule)) {
            return send(res, 400, { error: `Invalid schedule. Valid: ${VALID_SCHEDULES.join(', ')}` });
        }
        cfg.schedule = body.schedule;
    }

    if (body.scheduleMinute !== undefined) {
        const v = Math.floor(Number(body.scheduleMinute));
        if (!Number.isFinite(v) || v < 0 || v > 59) return send(res, 400, { error: 'scheduleMinute must be 0–59' });
        cfg.scheduleMinute = v;
    }

    if (body.scheduleHour !== undefined) {
        const v = Math.floor(Number(body.scheduleHour));
        if (!Number.isFinite(v) || v < 0 || v > 23) return send(res, 400, { error: 'scheduleHour must be 0–23' });
        cfg.scheduleHour = v;
    }

    if (body.retention !== undefined) {
        if (!VALID_RETENTIONS.includes(body.retention)) {
            return send(res, 400, { error: `Invalid retention. Valid: ${VALID_RETENTIONS.join(', ')}` });
        }
        cfg.retention = body.retention;
    }

    if (body.quotaMB !== undefined) {
        const v = Number(body.quotaMB);
        if (!Number.isFinite(v) || v < 0) return send(res, 400, { error: 'quotaMB must be >= 0' });
        cfg.quotaMB = v;
    }

    if (body.minFreeMB !== undefined) {
        const v = Number(body.minFreeMB);
        if (!Number.isFinite(v) || v < 0) return send(res, 400, { error: 'minFreeMB must be >= 0' });
        cfg.minFreeMB = v;
    }

    if (body.backupScope !== undefined) {
        const r = validateScopeInput(body.backupScope);
        if (!r.ok) return send(res, 400, { error: `backupScope: ${r.error}` });
        const merged = { ...cfg.backupScope || { ...DEFAULT_SCOPE }, ...r.value };
        // A scheduled backup runs with this scope unattended, so an all-off scope
        // would silently produce empty backups. Reject it at config time.
        if (isEmptyComponentScope(merged)) {
            return send(res, 400, { error: 'backupScope must include at least one component (database, assets, or extensions)' });
        }
        cfg.backupScope = merged;
    }

    await writeConfig(cfg);
    await applySchedule();
    appendActivity({ action: 'config' }).catch(() => {});
    send(res, 200, cfg);
}

/**
 * Returns storage info: used/free space and configured limits.
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleGetStorage(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });

    const cfg = await readConfig();
    const freeMB = getFreeMB();
    let usedMB = null;
    try {
        usedMB = Math.round(await dirSizeBytes(BACKUP_DIR) / (1024 * 1024));
    } catch (e) {
        console.warn('Backup size check failed:', /** @type {Error} */ (e).message);
    }
    send(res, 200, { usedMB, freeMB, quotaMB: cfg.quotaMB, minFreeMB: cfg.minFreeMB });
}

/**
 * Health check endpoint. This is the only route that does NOT require the
 * `X-Backup-Secret` header, so container healthchecks can probe it. It is a
 * pure liveness probe and intentionally returns no lock state or backup IDs,
 * so an exposed port cannot leak operational details to an unauthenticated
 * caller. The sidecar is expected to listen only on the internal network.
 * @param {Req} _req  Unused; present for the handler signature.
 * @param {Res} res   The HTTP response.
 */
function handleHealth(_req, res) {
    send(res, 200, { status: 'ok' });
}

/**
 * Initiates a restore from a completed backup. Responds immediately with 202;
 * the actual restore runs asynchronously (stop Directus → pg_restore → start).
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleRestore(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });

    const body = await parseJsonBody(req, res);
    if (!body) return;

    const { backupId, scope } = body;
    if (!validateBackupId(backupId, res)) return;

    let requestScope;
    if (scope !== undefined) {
        const r = validateScopeInput(scope);
        if (!r.ok) return send(res, 400, { error: `scope: ${r.error}` });
        requestScope = {
            database: typeof r.value.database === 'boolean' ? r.value.database : DEFAULT_SCOPE.database,
            assets: typeof r.value.assets === 'boolean' ? r.value.assets : DEFAULT_SCOPE.assets,
            extensions: typeof r.value.extensions === 'boolean' ? r.value.extensions : DEFAULT_SCOPE.extensions,
            includeCollections: r.value.includeCollections || []
        };
    }

    const backupPath = resolvePath(BACKUP_DIR, backupId);
    const manifest = await readManifest(backupPath);
    if (!manifest) return send(res, 404, { error: 'Backup not found' });
    if (manifest.status !== 'success') return send(res, 409, { error: 'Backup not in success state' });

    // Restore mutates the live system (LIVE_DB) and the backup directory it
    // reads from (backupId). Acquire LIVE_DB first, then the backup ID — the
    // fixed order keeps the lock acquisition total and deadlock-free.
    const startedAt = new Date().toISOString();
    const lockedLive = await acquireLock(LIVE_DB, { backupId, startedAt, operation: 'restore' });
    if (!lockedLive) return send(res, 409, { error: 'Another backup or restore is already running', code: 'ALREADY_RUNNING' });
    const lockedId = await acquireLock(backupId, { backupId, startedAt, operation: 'restore' });
    if (!lockedId) {
        await releaseLock(LIVE_DB);
        return send(res, 409, { error: 'Backup is in use by another operation' });
    }

    // Respond immediately; the actual restore runs async after this point.
    send(res, 202, { accepted: true, backupId });

    doRestore(backupId, /** @type {import('./lib/runner.js').Manifest} */ (manifest), backupPath, requestScope).catch(async e => {
        console.error(`Restore unhandled error for ${backupId}:`, /** @type {Error} */ (e).message);
        await releaseLock(backupId);
        await releaseLock(LIVE_DB);
    });
}

// ── LIST ──────────────────────────────────────────────────────

/**
 * Lists all backups, sorted newest-first by `createdAt`.
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleList(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });
    const manifests = await readAllManifests();
    manifests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    send(res, 200, manifests);
}

// ── DELETE ─────────────────────────────────────────────────────

/**
 * Deletes a backup directory. Rejects deletion of a backup that is still being
 * created (`status: running`) and holds the per-backup lock for the duration of
 * the removal, so a restore or download of the same backup can neither be in
 * progress nor start while the directory is being deleted.
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleDelete(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });

    const id = (req.url || '').split('/')[2];
    if (!validateBackupId(id, res)) return;

    const dir = resolvePath(BACKUP_DIR, id);
    const manifest = await readManifest(dir);
    if (!manifest) return send(res, 404, { error: 'Backup not found' });
    if (manifest.status === 'running') return send(res, 409, { error: 'Cannot delete running backup' });

    // Hold this backup's lock for the duration of the removal so a restore or
    // download of the same backup can neither be in progress nor start while we
    // delete the directory. The atomic `wx` acquire closes the check-then-delete
    // race. Unrelated backups/restores are not blocked.
    const locked = await acquireLock(id, { backupId: id, startedAt: new Date().toISOString(), operation: 'delete' });
    if (!locked) return send(res, 409, { error: 'Backup is in use by an active operation' });

    try {
        await rm(dir, { recursive: true });
    } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return send(res, 404, { error: 'Backup not found' });
        throw e;
    } finally {
        await releaseLock(id);
    }

    appendActivity({ action: 'delete', backupId: id }).catch(() => {});
    send(res, 200, { success: true });
}

// ── IMPORT (upload) ────────────────────────────────────────────

/**
 * Imports a backup from an uploaded `.tar.gz` archive. Validates archive
 * integrity (symlinks, device files, path traversal), extracts to the
 * backup directory, and verifies the manifest before accepting. Disk usage is
 * bounded twice: a streaming byte budget caps the compressed upload, and the
 * summed uncompressed size from the `tar tvzf` listing is checked against the
 * free-space margin before extraction (so a small archive that expands to a
 * huge tree cannot exhaust the disk during `tar xzf`). Once the backup ID is
 * known it holds that backup's per-ID lock for the existence check and
 * extraction, so an import cannot race a restore, download, delete, or another
 * import of the same ID. Import does not touch the live database, so it does
 * not take the `LIVE_DB` lock.
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleImport(req, res) { // eslint-disable-line max-lines-per-function
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });
    if (!IMPORT_ENABLED) return send(res, 403, { error: 'Backup import is disabled', code: 'IMPORT_DISABLED' });

    const tmpFile = join(BACKUP_DIR, `.upload-${Date.now()}.tar.gz`);
    let extractedId = null;
    let lockedId = null;

    try {
        // Guard against filling the disk during the upload. If free space is
        // already at/below the configured margin, reject up front; otherwise
        // stop accepting once the upload would eat into that margin.
        const cfg = await readConfig();
        const freeMB = getFreeMB();
        const { ok: spaceOk, budgetBytes } = uploadBudget(freeMB, cfg.minFreeMB);
        if (!spaceOk) {
            return send(res, 507, { error: `Storage limit reached: free space ${freeMB}MB <= min ${cfg.minFreeMB}MB`, code: 'DISK_FULL', freeMB, minFreeMB: cfg.minFreeMB });
        }

        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const ws = createWriteStream(tmpFile);
            let written = 0;
            let aborted = false;
            ws.on('error', reject);
            ws.on('finish', () => resolve());
            req.on('data', chunk => {
                if (aborted) return;
                written += chunk.length;
                if (budgetBytes !== null && written > budgetBytes) {
                    aborted = true;
                    req.unpipe(ws);
                    ws.destroy();
                    if (!res.headersSent) send(res, 507, { error: 'Upload exceeds available storage' });
                    req.destroy();
                    reject(new Error('Upload exceeds available storage'));
                }
            });
            req.pipe(ws);
        }));

        const tmpStat = await stat(tmpFile);
        if (tmpStat.size === 0) return send(res, 400, { error: 'Empty upload' });

        const listing = await new Promise((resolve, reject) => {
            const proc = spawn('tar', ['tvzf', tmpFile]);
            let out = '';
            proc.stdout.on('data', c => { out += c.toString(); });
            proc.on('close', code => (code === 0 ? resolve(out) : reject(new Error('Invalid or corrupted archive'))));
            proc.on('error', reject);
        });

        const entries = listing.trim().split('\n').filter(Boolean);
        if (entries.length === 0) return send(res, 400, { error: 'Archive is empty' });

        const topLevelDirs = new Set();
        let extractedBytes = 0;
        for (const entry of entries) {
            const parts = entry.trim().split(/\s+/);
            if (parts.length < 6) continue;

            const permissions = parts[0];
            const filename = parts.slice(5).join(' ').split(' -> ')[0];

            if (permissions[0] === 'l') return send(res, 400, { error: 'Archive contains symlinks (security risk)' });
            if ('bcps'.includes(permissions[0])) return send(res, 400, { error: 'Archive contains device files, pipes, or sockets (security risk)' });
            if (filename.startsWith('/') || filename.includes('..')) return send(res, 400, { error: 'Archive contains unsafe paths' });

            // Column 2 of `tar tvzf` is the uncompressed entry size (same fixed GNU/BusyBox layout the filename parse above relies on). The tar
            // header size is what tar will actually write, so it is a reliable budget input — a lying header would corrupt the archive instead.
            const size = Number.parseInt(parts[2], 10);
            if (Number.isFinite(size)) extractedBytes += size;

            const top = filename.split('/')[0];
            if (top) topLevelDirs.add(top);
        }

        if (topLevelDirs.size !== 1) return send(res, 400, { error: 'Archive must contain exactly one backup directory' });

        // A small compressed archive can expand to a huge tree. checkQuota() runs only after extraction, so bound the extracted size up front
        // against the current free-space margin before tar writes anything.
        const extractBudget = uploadBudget(getFreeMB(), cfg.minFreeMB);
        if (!extractBudget.ok) return send(res, 507, { error: 'Storage limit reached before extraction' });
        if (extractBudget.budgetBytes !== null && extractedBytes > extractBudget.budgetBytes) {
            return send(res, 507, { error: `Extracted size ~${Math.round(extractedBytes / (1024 * 1024))}MB exceeds available storage` });
        }

        // Check quota pre-extraction using the uncompressed size from the tar listing. This avoids the write-then-rollback cycle that the
        // post-extraction checkQuota() would otherwise trigger.
        if (cfg.quotaMB > 0) {
            let currentUsedMB = null;
            try {
                currentUsedMB = Math.round(await dirSizeBytes(BACKUP_DIR) / (1024 * 1024));
            } catch { /* skip check if size measurement fails */ }
            if (currentUsedMB !== null) {
                const importMB = Math.round(extractedBytes / (1024 * 1024));
                if (currentUsedMB + importMB > cfg.quotaMB) {
                    return send(res, 507, {
                        error: `Quota would be exceeded: current ${currentUsedMB}MB + import ~${importMB}MB > quota ${cfg.quotaMB}MB`,
                        code: 'QUOTA_IMPORT_EXCEEDED',
                        usedMB: currentUsedMB,
                        importMB,
                        quotaMB: cfg.quotaMB
                    });
                }
            }
        }

        const backupId = [...topLevelDirs][0];
        if (!BACKUP_ID_RE.test(backupId)) return send(res, 400, { error: 'Archive directory name is not a valid backup ID' });

        const targetDir = resolvePath(BACKUP_DIR, backupId);
        if (!targetDir.startsWith(`${resolvePath(BACKUP_DIR)}/`)) return send(res, 400, { error: 'Invalid backup ID in archive' });

        // Serialize against any other operation on this backup ID before the existence check and extraction. Import is storage-only, so it takes
        // just the per-backup lock, not LIVE_DB.
        if (!await acquireLock(backupId, { backupId, startedAt: new Date().toISOString(), operation: 'import' })) {
            return send(res, 409, { error: 'Backup is in use by an active operation' });
        }
        lockedId = backupId;

        try {
            await stat(targetDir);
            return send(res, 409, { error: `Backup ${backupId} already exists` });
        } catch (e) {
            if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
        }

        extractedId = backupId;

        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const proc = spawn('tar', ['xzf', tmpFile, '-C', BACKUP_DIR, '-o', '--no-same-permissions', '-h']);
            proc.on('close', code => (code === 0 ? resolve(undefined) : reject(new Error(`tar extract failed (code=${code})`))));
            proc.on('error', reject);
        }));

        try { await rm(tmpFile, { force: true }); } catch { /* ignore */ }

        const manifest = await readManifest(targetDir);

        // Validate the extracted archive before committing it. For any failure
        // after extraction the directory must be removed *before* the response
        // is sent so the client never observes a partial/invalid backup on disk.
        /**
         * Removes the just-extracted directory, then sends the rejection response.
         * @param {number} status  The HTTP status code to send.
         * @param {Object} body    The JSON error body to send.
         */
        const rejectExtracted = async(status, body) => {
            try { await rm(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
            extractedId = null;
            send(res, status, body);
        };

        if (!manifest) return rejectExtracted(400, { error: 'Archive does not contain a valid backup manifest' });
        // The archive directory name is the canonical backup ID and the only value
        // used to address this backup for restore/download/delete. Require the
        // manifest to agree, so an imported backup cannot be listed under a
        // different (or duplicate) ID that later fails to resolve to its directory.
        if (manifest.id !== backupId) return rejectExtracted(400, { error: 'Archive manifest id does not match the archive directory name' });
        if (manifest.status !== 'success') return rejectExtracted(409, { error: `Backup has status "${manifest.status}", only successful backups can be imported` });

        // Reject archives whose manifest claims a component that is not physically present.
        // This keeps imported backups as consistent as self-created ones (where set -e
        // guarantees a successful backup contains every component its scope declares), so a
        // later restore can never encounter a requested-but-missing component.
        /** @type {{ database?: boolean, assets?: boolean, extensions?: boolean }} */
        const scope = manifest.scope || {};
        const dbFile = (manifest.dumpFormat || 'custom') === 'plain' ? 'database.sql' : 'database.dump';
        /** @type {Array<[boolean, string]>} */
        const requiredFiles = [
            [scope.database !== false, dbFile],
            [scope.assets !== false, 'uploads.tar.gz'],
            [scope.extensions !== false, 'extensions.tar.gz']
        ];
        for (const [included, file] of requiredFiles) {
            if (!included) continue;
            try {
                await stat(join(targetDir, file));
            } catch {
                return rejectExtracted(400, { error: `Archive manifest declares a component the archive does not contain: ${file} is missing` });
            }
        }

        const quota = await checkQuota();
        if (!quota.ok) {
            const first = quota.reasons[0];
            return rejectExtracted(507, { ...first, error: quota.reasons.map(r => r.text).join('; ') });
        }

        extractedId = null;
        appendActivity({ action: 'upload', backupId }).catch(() => {});
        send(res, 200, manifest);
    } catch (e) {
        const msg = /** @type {Error} */ (e).message || 'Upload failed';
        if (!res.headersSent) send(res, 400, { error: msg });
    } finally {
        try { await rm(tmpFile, { force: true }); } catch { /* ignore */ }
        if (extractedId) {
            const dir = resolvePath(BACKUP_DIR, extractedId);
            try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        if (lockedId) await releaseLock(lockedId);
    }
}

// ── DOWNLOAD ───────────────────────────────────────────────────

/**
 * Streams a backup as a `.tar.gz` download. Rejects a backup that is still being
 * created (`status: running`). Holds the per-backup lock for the entire stream
 * so a concurrent restore or delete of the same backup cannot mutate or remove
 * the directory while tar reads it, which would otherwise yield a truncated or
 * inconsistent archive. The lock is released when tar finishes, errors, or the
 * client disconnects.
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleDownload(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });
    if (!EXPORT_ENABLED) return send(res, 403, { error: 'Backup export is disabled', code: 'EXPORT_DISABLED' });

    const parts = (req.url || '').split('/');
    const id = parts[2];
    if (!validateBackupId(id, res)) return;

    const dir = resolvePath(BACKUP_DIR, id);
    const manifest = await readManifest(dir);
    if (!manifest) return send(res, 404, { error: 'Backup not found' });
    if (manifest.status === 'running') return send(res, 409, { error: 'Cannot download running backup' });

    const locked = await acquireLock(id, { backupId: id, startedAt: new Date().toISOString(), operation: 'download' });
    if (!locked) return send(res, 409, { error: 'Backup is in use by an active operation' });

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        releaseLock(id).catch(e => console.warn(`Download lock release failed for ${id}:`, /** @type {Error} */ (e).message));
    };

    res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${id}.tar.gz"`
    });
    const tar = spawn('tar', ['czf', '-', '-C', BACKUP_DIR, id], { stdio: ['ignore', 'pipe', 'pipe'] });
    tar.stdout.pipe(res);
    tar.stderr.on('data', c => console.error(`tar stderr: ${c.toString()}`));
    tar.on('error', () => {
        release();
        if (!res.headersSent) send(res, 500, { error: 'Archive failed' });
    });
    tar.on('close', code => {
        release();
        if (code !== 0 && !res.headersSent) send(res, 500, { error: 'Archive failed' });
    });
    // Client disconnected before the stream finished: stop tar and release.
    res.on('close', () => {
        if (tar.exitCode === null && !tar.killed) tar.kill();
        release();
    });
}

// ── ACTIVITY ───────────────────────────────────────────────────

/**
 * Returns the activity log (last N events, newest first).
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
async function handleGetActivity(req, res) {
    if (!checkSecret(req)) return send(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url || '/', 'http://localhost');
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    send(res, 200, await readActivity(Math.min(Math.max(limit, 1), 100)));
}

// ── Cron scheduling ───────────────────────────────────────────

/** @type {import('node-cron').ScheduledTask | null} */
let cronTask = null;

/**
 * Reads the current schedule config and (re-)schedules the cron job.
 * Safe to call multiple times; always cancels the previous job first.
 */
export async function applySchedule() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }

    const cfg = await readConfig();
    const expr = buildCronExpr(cfg.schedule, cfg.scheduleMinute, cfg.scheduleHour);
    if (!expr) {
        console.log('Schedule: off');
        return;
    }

    cronTask = cron.schedule(expr, async() => {
        console.log('Cron triggered: starting scheduled backup');
        const id = generateBackupId('scheduled');
        const result = await startBackup(id, 'scheduled');
        if (!result.ok) {
            console.warn(`Scheduled backup failed to start: ${result.error}`);
            appendActivity({ action: 'backup_failed', backupId: id, source: 'scheduled', detail: result.error }).catch(() => {});
        }
    });

    console.log(`Schedule: ${cfg.schedule} (${expr})`);
}

// ── Server ────────────────────────────────────────────────────

/**
 * Routes an incoming HTTP request to the matching handler. Exported so
 * integration tests can drive the routing logic without binding the port or
 * triggering the Docker/cron startup sequence.
 * @param   {Req}           req  The incoming HTTP request.
 * @param   {Res}           res  The HTTP response.
 * @returns {Promise<void>}
 */
export async function requestHandler(req, res) {
    const url = req.url || '';
    try {
        if (req.method === 'POST' && url === '/run') await handleRun(req, res);
        else if (req.method === 'POST' && url === '/cancel') await handleCancel(req, res);
        else if (req.method === 'POST' && url === '/restore') await handleRestore(req, res);
        else if (req.method === 'GET' && url === '/list') await handleList(req, res);
        else if (req.method === 'GET' && url === '/config') await handleGetConfig(req, res);
        else if (req.method === 'PUT' && url === '/config') await handlePutConfig(req, res);
        else if (req.method === 'GET' && url === '/storage') await handleGetStorage(req, res);
        else if (req.method === 'GET' && url === '/health') await handleHealth(req, res);
        else if (req.method === 'DELETE' && url.startsWith('/backup/')) await handleDelete(req, res);
        else if (req.method === 'POST' && url === '/import') await handleImport(req, res);
        else if (req.method === 'GET' && url.match(/^\/backup\/[^/]+\/download$/)) await handleDownload(req, res);
        else if (req.method === 'GET' && url.startsWith('/activity')) await handleGetActivity(req, res);
        else send(res, 404, { error: 'Not found' });
    } catch (e) {
        console.error('Unhandled:', e);
        if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
}

const server = createServer(requestHandler);

// Only run the Docker/cron startup sequence and bind the port when executed
// directly (`node server.js`), not when imported by tests.
const isMain = Boolean(process.argv[1]) && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    (async() => {
        await discoverDirectus();
        await recoverStaleLocks();
        await reconcileRunningManifests();
        await applySchedule();
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`Backup sidecar listening on ${PORT}`);
        });
    })();
}
