import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            reportsDirectory: 'test/coverage',
            // .vue components are not instrumented here (no Vue plugin in this
            // test setup); coverage tracks the testable .ts logic.
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.d.ts']
        }
    }
});
