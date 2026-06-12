/**
 * Backup table sorting tests.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useBackupTable } from '../../src/module/composables/useBackupTable.js';
import type { BackupManifest } from '../../src/shared/types.js';

const t = (key: string) => key;

function manifest(id: string, sizeBytes: number): BackupManifest {
    return {
        id,
        label: id,
        status: 'success',
        sizeBytes,
        createdAt: `2026-01-01T00:00:0${sizeBytes % 10}.000Z`
    };
}

describe('useBackupTable', () => {
    it('sorts sizeBytes numerically', () => {
        const backups = ref([
            manifest('large', 100),
            manifest('small', 99),
            manifest('tiny', 2)
        ]);
        const table = useBackupTable(backups, t);

        table.sortState.value = { by: 'sizeBytes', desc: false };
        expect(table.sortedBackups.value.map(b => b.id)).toEqual(['tiny', 'small', 'large']);

        table.sortState.value = { by: 'sizeBytes', desc: true };
        expect(table.sortedBackups.value.map(b => b.id)).toEqual(['large', 'small', 'tiny']);
    });
});
