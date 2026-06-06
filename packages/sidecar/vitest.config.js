import { defineConfig } from 'vitest/config';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.js'],
        testTimeout: 30_000,
        hookTimeout: 30_000,
        fileParallelism: false,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            reportsDirectory: 'test/coverage',
            include: ['lib/**/*.js', 'server.js']
        },
        env: {
            BACKUP_SECRET: 'test-secret',
            BACKUP_DIR: join(tmpdir(), 'directus-backup-test'),
            BACKUP_IMPORT_ENABLED: 'true',
            BACKUP_EXPORT_ENABLED: 'true'
        }
    }
});
