/**
 * Installation sanity check tests.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initConfig } from '../../src/api/core/config.js';
import { runSanityCheck, resetSanityCache, commandExists } from '../../src/api/core/sanity.js';

let WORK: string;

beforeAll(async () => {
    WORK = join(tmpdir(), `sanity-${Date.now()}`);
    await mkdir(WORK, { recursive: true });
    const scripts = join(WORK, 'pkg', 'scripts');
    const adapters = join(scripts, 'adapters');
    await mkdir(adapters, { recursive: true });
    await writeFile(join(scripts, 'backup.sh'), '#!/bin/sh\n');
    await writeFile(join(scripts, 'restore.sh'), '#!/bin/sh\n');
    await writeFile(join(adapters, 'postgres.sh'), '#!/bin/sh\n');
    initConfig({
        BACKUP_DIR: WORK,
        EXTENSIONS_DIR: join(WORK, 'ext'),
        EXTENSIONS_PATH: join(WORK, 'ext'),
        DB_ADAPTER: 'postgres'
    });
    await mkdir(join(WORK, 'ext', 'directus-extension-backup', 'scripts'), { recursive: true });
    for (const f of ['backup.sh', 'restore.sh']) {
        await writeFile(join(WORK, 'ext', 'directus-extension-backup', 'scripts', f), '#!/bin/sh\n');
    }
    await mkdir(join(WORK, 'ext', 'directus-extension-backup', 'scripts', 'adapters'), { recursive: true });
    await writeFile(join(WORK, 'ext', 'directus-extension-backup', 'scripts', 'adapters', 'postgres.sh'), '#!/bin/sh\n');
});

afterAll(async () => {
    resetSanityCache();
    await rm(WORK, { recursive: true, force: true });
});

afterEach(() => {
    resetSanityCache();
    initConfig({
        BACKUP_DIR: WORK,
        EXTENSIONS_DIR: join(WORK, 'ext'),
        EXTENSIONS_PATH: join(WORK, 'ext'),
        DB_ADAPTER: 'postgres'
    });
});

describe('sanity', () => {
    it('commandExists finds sh on POSIX hosts', async () => {
        expect(await commandExists('sh')).toBe(true);
    });

    it('returns a structured report with coded issues', async () => {
        resetSanityCache();
        const report = await runSanityCheck();
        expect(report).toMatchObject({
            ok: expect.any(Boolean),
            operational: expect.any(Boolean),
            restoreReady: expect.any(Boolean),
            checkedAt: expect.any(String)
        });
        expect(report.issues.some(i => i.code === 'SCRIPTS_MISSING')).toBe(false);
        for (const item of report.issues) {
            expect(item.code.length).toBeGreaterThan(0);
            expect(['error', 'warning']).toContain(item.severity);
            expect(item.message.length).toBeGreaterThan(0);
        }
    });

    it('blocks unsupported database adapters explicitly', async () => {
        initConfig({
            BACKUP_DIR: WORK,
            EXTENSIONS_DIR: join(WORK, 'ext'),
            EXTENSIONS_PATH: join(WORK, 'ext'),
            DB_ADAPTER: 'mysql'
        });

        const report = await runSanityCheck();

        expect(report.operational).toBe(false);
        expect(report.restoreReady).toBe(false);
        expect(report.issues).toContainEqual(expect.objectContaining({
            code: 'UNSUPPORTED_ADAPTER',
            severity: 'error',
            params: expect.objectContaining({ adapter: 'mysql', supported: 'postgres' })
        }));
    });
});
