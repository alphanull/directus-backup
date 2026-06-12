/**
 * Append-only activity log stored as JSON-Lines under `BACKUP_DIR`.
 * Each line is a single JSON object with a timestamp and event data.
 *
 * The log path is derived from {@link config} at call time, so it always
 * reflects the initialised backup directory.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import type { ActivityEntry } from '../../shared/types.js';

const LOG_FILE_NAME = 'backup-activity.jsonl';
const MAX_ENTRIES = 100;
const TRIM_THRESHOLD = 200;

/** Absolute path to the activity log file on the backup volume. */
function logFile(): string {
    return join(config.backupDir, LOG_FILE_NAME);
}

/**
 * Appends an activity entry. Trims the file when it exceeds `TRIM_THRESHOLD` lines.
 * @param entry  Event to append; the timestamp is added automatically.
 */
export async function appendActivity(entry: Omit<ActivityEntry, 'timestamp'>): Promise<void> {
    const full: ActivityEntry = { timestamp: new Date().toISOString(), ...entry };
    const file = logFile();

    await appendFile(file, `${JSON.stringify(full)}\n`, 'utf8');

    try {
        const raw = await readFile(file, 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean);
        if (lines.length > TRIM_THRESHOLD) {
            await writeFile(file, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, 'utf8');
        }
    } catch {
        // Rotation failure is non-critical
    }
}

/**
 * Reads activity entries, newest first.
 * @param limit  Maximum number of entries to return.
 * @returns      The most recent entries, newest first.
 */
export async function readActivity(limit = MAX_ENTRIES): Promise<ActivityEntry[]> {
    try {
        const raw = await readFile(logFile(), 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean);
        const entries: ActivityEntry[] = [];
        for (const line of lines) {
            try {
                entries.push(JSON.parse(line));
            } catch {
                // Skip malformed lines
            }
        }
        return entries.slice(-limit).reverse();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
    }
}
