import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_DIR } from '../../lib/config.js';
import { spawnRunner } from '../../lib/runner.js';

const logPath = join(BACKUP_DIR, 'runner-timeout.log');

beforeEach(async () => {
	await rm(BACKUP_DIR, { recursive: true, force: true });
	await mkdir(BACKUP_DIR, { recursive: true });
});

afterAll(async () => {
	await rm(BACKUP_DIR, { recursive: true, force: true });
});

describe('spawnRunner timeout', () => {
	it('terminates a hanging child and resolves as a non-zero, timed-out failure', async () => {
		const start = Date.now();
		const { exitCode, timedOut } = await spawnRunner({}, logPath, {
			timeoutMs: 200,
			command: 'sh',
			args: ['-c', 'sleep 30']
		});

		expect(timedOut).toBe(true);
		expect(exitCode).not.toBe(0);
		// Must not hang anywhere near the 30s sleep.
		expect(Date.now() - start).toBeLessThan(10_000);

		const log = await readFile(logPath, 'utf8');
		expect(log).toMatch(/exceeded timeout/i);
	});

	it('does not interfere with a child that exits before the timeout', async () => {
		const { exitCode, timedOut } = await spawnRunner({}, logPath, {
			timeoutMs: 10_000,
			command: 'sh',
			args: ['-c', 'exit 0']
		});

		expect(timedOut).toBe(false);
		expect(exitCode).toBe(0);
	});

	it('preserves the child exit code and is disabled when timeoutMs is 0', async () => {
		const { exitCode, timedOut } = await spawnRunner({}, logPath, {
			timeoutMs: 0,
			command: 'sh',
			args: ['-c', 'exit 3']
		});

		expect(timedOut).toBe(false);
		expect(exitCode).toBe(3);
	});
});
