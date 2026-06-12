/**
 * Runner environment construction.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect } from 'vitest';
import { initConfig } from '../../src/api/core/config.js';
import { buildRunnerEnv } from '../../src/api/backup/process.js';

describe('buildRunnerEnv', () => {
    it('passes the configured database port to the runner', () => {
        initConfig({ DB_PORT: '15432' });

        const env = buildRunnerEnv('2026-01-01__00-00-00__manual', '/tmp/backup', []);

        expect(env.DB_PORT).toBe('15432');
    });
});
