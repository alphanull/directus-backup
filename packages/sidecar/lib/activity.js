/**
 * Append-only activity log stored as JSON-Lines in BACKUP_DIR.
 * Each line is a single JSON object with a timestamp and event data.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_DIR } from './config.js';

const LOG_FILE = join(BACKUP_DIR, 'backup-activity.jsonl');
const MAX_ENTRIES = 100;
const TRIM_THRESHOLD = 200;

/**
 * A single activity-log event.
 * @typedef  {Object} ActivityEntry
 * @property {string} timestamp   ISO timestamp; added automatically on append.
 * @property {string} action      Event type, e.g. `backup_success`.
 * @property {string} [backupId]  Backup ID the event refers to.
 * @property {string} [source]    What triggered the event, e.g. `manual`.
 * @property {string} [detail]    Additional detail or error message.
 */

/**
 * Appends an activity entry. Trims the file when it exceeds TRIM_THRESHOLD lines.
 * @param {Omit<ActivityEntry, 'timestamp'>} entry  Event to append; the timestamp is added automatically.
 */
export async function appendActivity(entry) {
    const full = { timestamp: new Date().toISOString(), ...entry };

    await appendFile(LOG_FILE, `${JSON.stringify(full)}\n`, 'utf8');

    try {
        const raw = await readFile(LOG_FILE, 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean);
        if (lines.length > TRIM_THRESHOLD) {
            await writeFile(LOG_FILE, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, 'utf8');
        }
    } catch {
        // Rotation failure is non-critical
    }
}

/**
 * Reads activity entries, newest first.
 * @param   {number}                   limit  Maximum number of entries to return.
 * @returns {Promise<ActivityEntry[]>}        The most recent entries, newest first.
 */
export async function readActivity(limit = MAX_ENTRIES) {
    try {
        const raw = await readFile(LOG_FILE, 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean);
        const entries = [];
        for (const line of lines) {
            try {
                entries.push(JSON.parse(line));
            } catch {
                // Skip malformed lines
            }
        }
        return entries.slice(-limit).reverse();
    } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
        throw err;
    }
}
