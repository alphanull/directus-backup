/**
 * Append-only activity log (JSON-Lines) plus the shared ActivityEntry shape.
 * Merges the sidecar `activity` suite (behaviour) with the extension's
 * structural type check.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdir, rm, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initConfig, config } from '../../src/api/core/config.js';
import { appendActivity, readActivity } from '../../src/api/core/activity.js';
import type { ActivityEntry } from '../../src/shared/types.js';

let BACKUP_DIR: string;
const logFile = () => join(config.backupDir, 'backup-activity.jsonl');

beforeAll(async () => {
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'dbk-activity-'));
    initConfig({ BACKUP_DIR });
});

beforeEach(async () => {
    await rm(config.backupDir, { recursive: true, force: true });
    await mkdir(config.backupDir, { recursive: true });
});

afterAll(async () => {
    await rm(BACKUP_DIR, { recursive: true, force: true });
});

describe('appendActivity', () => {
    it('appends an entry with auto-generated timestamp', async () => {
        await appendActivity({ action: 'backup_success', backupId: 'test-1' });
        const raw = await readFile(logFile(), 'utf8');
        const entry = JSON.parse(raw.trim());
        expect(entry.action).toBe('backup_success');
        expect(entry.backupId).toBe('test-1');
        expect(entry.timestamp).toBeTruthy();
    });

    it('appends multiple entries on separate lines', async () => {
        await appendActivity({ action: 'backup_start' });
        await appendActivity({ action: 'backup_success' });
        const lines = (await readFile(logFile(), 'utf8')).trim().split('\n');
        expect(lines).toHaveLength(2);
    });
});

describe('readActivity', () => {
    it('returns entries newest first', async () => {
        await appendActivity({ action: 'first' });
        await appendActivity({ action: 'second' });
        const entries = await readActivity();
        expect(entries[0].action).toBe('second');
        expect(entries[1].action).toBe('first');
    });

    it('returns empty array when file does not exist', async () => {
        const entries = await readActivity();
        expect(entries).toEqual([]);
    });

    it('respects limit parameter', async () => {
        for (let i = 0; i < 5; i++) {
            await appendActivity({ action: `entry-${i}` });
        }
        const entries = await readActivity(3);
        expect(entries).toHaveLength(3);
        expect(entries[0].action).toBe('entry-4');
    });

    it('skips malformed lines', async () => {
        await writeFile(logFile(), '{"action":"good"}\nnot json\n{"action":"also-good"}\n');
        const entries = await readActivity();
        expect(entries).toHaveLength(2);
    });
});

describe('trim behavior', () => {
    it('trims log to 100 entries when exceeding 200', async () => {
        const lines: string[] = [];
        for (let i = 0; i < 201; i++) {
            lines.push(JSON.stringify({ timestamp: new Date().toISOString(), action: `entry-${i}` }));
        }
        await writeFile(logFile(), `${lines.join('\n')}\n`);

        await appendActivity({ action: 'trigger-trim' });

        const raw = await readFile(logFile(), 'utf8');
        const remaining = raw.trim().split('\n').filter(Boolean);
        expect(remaining.length).toBe(100);
    });
});

describe('ActivityEntry type', () => {
    it('is structurally valid', () => {
        const entry: ActivityEntry = {
            timestamp: '2026-01-01T00:00:00Z',
            action: 'backup_success',
            backupId: 'test-id',
            source: 'manual'
        };
        expect(entry.action).toBe('backup_success');
        expect(entry.source).toBe('manual');
    });

    it('allows optional fields to be omitted', () => {
        const entry: ActivityEntry = {
            timestamp: '2026-01-01T00:00:00Z',
            action: 'config'
        };
        expect(entry.backupId).toBeUndefined();
        expect(entry.source).toBeUndefined();
        expect(entry.detail).toBeUndefined();
    });
});
