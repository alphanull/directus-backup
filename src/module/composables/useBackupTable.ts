/**
 * Backup table composable — sort state, persisted column widths, and the
 * schedule/retention select options for the module UI.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { ref, computed, type Ref } from 'vue';
import type { BackupManifest } from '../../shared/types.js';

const WIDTHS_KEY = 'backup-table-widths';
const defaultWidths: Record<string, number> = {
    label: 200, status: 140, sizeBytes: 100, createdAt: 200, restoredAt: 200, actions: 130
};

/** Compares table values without turning numbers into lexicographic strings. */
function compareValues(a: unknown, b: unknown): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Reads persisted column widths from localStorage, falling back to defaults. */
function loadWidths(): Record<string, number> {
    try {
        const raw = localStorage.getItem(WIDTHS_KEY);
        return raw ? { ...defaultWidths, ...JSON.parse(raw) } : { ...defaultWidths };
    } catch {
        return { ...defaultWidths };
    }
}

/**
 * Provides sorting, sorted rows, table headers with persisted widths, and the
 * schedule/retention option lists.
 * @param backups  Reactive list of backups to sort and display.
 * @param t        I18n translate function.
 * @returns        Sort state, sorted rows, headers, the header-update handler, and option lists.
 */
export function useBackupTable(backups: Ref<BackupManifest[]>, t: (key: string) => string) {
    const sortBy = ref('createdAt');
    const sortDesc = ref(true);

    const sortState = computed({
        get: () => ({ by: sortBy.value, desc: sortDesc.value }),
        set: (v: { by: string, desc: boolean } | null) => {
            if (v?.by) {
                sortBy.value = v.by;
                sortDesc.value = v.desc;
            }
        }
    });

    const sortedBackups = computed(() => {
        const by = sortBy.value;
        const desc = sortDesc.value;
        return [...backups.value].sort((a, b) => {
            const va = (a as unknown as Record<string, unknown>)[by];
            const vb = (b as unknown as Record<string, unknown>)[by];
            const cmp = compareValues(va, vb);
            return desc ? -cmp : cmp;
        });
    });

    const columnWidths = ref<Record<string, number>>(loadWidths());

    const headers = computed(() => [
        { text: t('backup.table.label'), value: 'label', width: columnWidths.value.label },
        { text: t('backup.table.status'), value: 'status', width: columnWidths.value.status },
        { text: t('backup.table.size'), value: 'sizeBytes', width: columnWidths.value.sizeBytes },
        { text: t('backup.table.created'), value: 'createdAt', width: columnWidths.value.createdAt },
        { text: t('backup.table.restored'), value: 'restoredAt', width: columnWidths.value.restoredAt, sortable: false },
        { text: t('backup.table.actions'), value: 'actions', width: columnWidths.value.actions, sortable: false }
    ]);

    /** Persists changed column widths to localStorage. */
    function onHeadersUpdate(updated: Array<{ value: string, width?: number }>) {
        const widths = { ...columnWidths.value };
        for (const h of updated) {
            if (h.width !== undefined && h.value in widths) widths[h.value] = h.width;
        }
        columnWidths.value = widths;
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
    }

    const scheduleOptions = computed(() => [
        { text: t('backup.schedule.off'), value: 'off' },
        { text: t('backup.schedule.hourly'), value: '1h' },
        { text: t('backup.schedule.every_6h'), value: '6h' },
        { text: t('backup.schedule.every_12h'), value: '12h' },
        { text: t('backup.schedule.daily'), value: 'daily' },
        { text: t('backup.schedule.every_3d'), value: '3d' },
        { text: t('backup.schedule.weekly'), value: 'weekly' }
    ]);

    const retentionOptions = computed(() => [
        { text: t('backup.retention.all'), value: 'all' },
        { text: t('backup.retention.last_3'), value: 'last-3' },
        { text: t('backup.retention.last_5'), value: 'last-5' },
        { text: t('backup.retention.last_10'), value: 'last-10' },
        { text: t('backup.retention.days_7'), value: 'days-7' },
        { text: t('backup.retention.days_30'), value: 'days-30' }
    ]);

    return {
        sortState,
        sortedBackups,
        headers,
        onHeadersUpdate,
        scheduleOptions,
        retentionOptions
    };
}
