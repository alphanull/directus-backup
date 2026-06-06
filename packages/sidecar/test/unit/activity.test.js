import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_DIR } from '../../lib/config.js';
import { appendActivity, readActivity } from '../../lib/activity.js';

const LOG_FILE = join(BACKUP_DIR, 'backup-activity.jsonl');

beforeEach(async () => {
	await rm(BACKUP_DIR, { recursive: true, force: true });
	await mkdir(BACKUP_DIR, { recursive: true });
});

afterAll(async () => {
	await rm(BACKUP_DIR, { recursive: true, force: true });
});

describe('appendActivity', () => {
	it('appends an entry with auto-generated timestamp', async () => {
		await appendActivity({ action: 'backup_success', backupId: 'test-1' });
		const raw = await readFile(LOG_FILE, 'utf8');
		const entry = JSON.parse(raw.trim());
		expect(entry.action).toBe('backup_success');
		expect(entry.backupId).toBe('test-1');
		expect(entry.timestamp).toBeTruthy();
	});

	it('appends multiple entries on separate lines', async () => {
		await appendActivity({ action: 'backup_start' });
		await appendActivity({ action: 'backup_success' });
		const lines = (await readFile(LOG_FILE, 'utf8')).trim().split('\n');
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
		await writeFile(LOG_FILE, '{"action":"good"}\nnot json\n{"action":"also-good"}\n');
		const entries = await readActivity();
		expect(entries).toHaveLength(2);
	});
});

describe('trim behavior', () => {
	it('trims log to 100 entries when exceeding 200', async () => {
		const lines = [];
		for (let i = 0; i < 201; i++) {
			lines.push(JSON.stringify({ timestamp: new Date().toISOString(), action: `entry-${i}` }));
		}
		await writeFile(LOG_FILE, lines.join('\n') + '\n');

		await appendActivity({ action: 'trigger-trim' });

		const raw = await readFile(LOG_FILE, 'utf8');
		const remaining = raw.trim().split('\n').filter(Boolean);
		expect(remaining.length).toBe(100);
	});
});
