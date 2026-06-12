/**
 * spawnRunner watchdog: a hanging child is terminated and reported as a
 * timed-out, non-zero failure; well-behaved children are unaffected.
 * Ported from the sidecar suite.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { rm, mkdir, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initConfig, config } from '../../src/api/core/config.js';
import { spawnRunner } from '../../src/api/backup/process.js';
import { setRuntime } from '../../src/api/core/runtime.js';

let BACKUP_DIR: string;
const logPath = () => join(config.backupDir, 'runner-timeout.log');

beforeAll(async () => {
    BACKUP_DIR = await mkdtemp(join(tmpdir(), 'dbk-timeout-'));
    initConfig({ BACKUP_DIR });
    setRuntime({
        getSchema: async () => ({}),
        services: {},
        database: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
});

beforeEach(async () => {
    await rm(config.backupDir, { recursive: true, force: true });
    await mkdir(config.backupDir, { recursive: true });
});

afterAll(async () => {
    await rm(BACKUP_DIR, { recursive: true, force: true });
});

describe('spawnRunner timeout', () => {
    it('terminates a hanging child and resolves as a non-zero, timed-out failure', async () => {
        const start = Date.now();
        const { exitCode, timedOut } = await spawnRunner({}, logPath(), {
            timeoutMs: 200,
            command: 'sh',
            args: ['-c', 'sleep 30']
        });

        expect(timedOut).toBe(true);
        expect(exitCode).not.toBe(0);
        expect(Date.now() - start).toBeLessThan(10_000);

        const log = await readFile(logPath(), 'utf8');
        expect(log).toMatch(/exceeded timeout/i);
    });

    it('does not interfere with a child that exits before the timeout', async () => {
        const { exitCode, timedOut } = await spawnRunner({}, logPath(), {
            timeoutMs: 10_000,
            command: 'sh',
            args: ['-c', 'exit 0']
        });

        expect(timedOut).toBe(false);
        expect(exitCode).toBe(0);
    });

    it('preserves the child exit code and is disabled when timeoutMs is 0', async () => {
        const { exitCode, timedOut } = await spawnRunner({}, logPath(), {
            timeoutMs: 0,
            command: 'sh',
            args: ['-c', 'exit 3']
        });

        expect(timedOut).toBe(false);
        expect(exitCode).toBe(3);
    });
});
