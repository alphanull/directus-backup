<!--
  Backup list table — renders the sortable/resizable backup table with per-row
  status, restore info, and action buttons. All mutations are delegated to the
  parent via events; sort state is two-way bound.

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <div class="backup-content">
        <div v-if="loading && items.length === 0" class="center">
            <v-progress-circular indeterminate />
        </div>

        <v-table
            v-else-if="items.length > 0"
            :headers="headers"
            :items="items"
            item-key="id"
            :loading="loading"
            v-model:sort="sort"
            must-sort
            show-resize
            @update:headers="$emit('headersUpdate', $event)"
            @click:row="$emit('rowClick', $event)"
        >
            <template #item.label="{ item }">
                <span class="label-cell">
                    <v-icon :name="item.source === 'scheduled' ? 'schedule' : 'person'" class="source-icon" />
                    {{ item.label }}
                </span>
            </template>

            <template #item.status="{ item }">
                <v-chip :class="['status-chip', `status-${item.status}`]" small>
                    {{ t('backup.status.' + item.status) }}
                </v-chip>
            </template>

            <template #item.restoredAt="{ item }">
                <span
                    v-if="item.restoredAt"
                    class="restored-cell"
                    :class="{ 'restored-failed': item.restoreStatus === 'failed' }"
                >
                    {{ formatDate(item.restoredAt) }}
                    <span v-if="item.restoreStatus === 'failed'" class="restored-error-hint"> {{ t('backup.status.restore_failed') }}</span>
                </span>
                <span v-else class="restored-empty">—</span>
            </template>

            <template #item.sizeBytes="{ item }">
                {{ item.sizeBytes ? formatSize(item.sizeBytes) : '—' }}
            </template>

            <template #item.createdAt="{ item }">
                {{ formatDate(item.createdAt) }}
            </template>

            <template #item.actions="{ item }">
                <div v-if="item.status === 'running'" class="action-buttons" @click.stop>
                    <v-button
                        icon rounded secondary small
                        :loading="cancellingId === item.id"
                        :disabled="cancellingId === item.id"
                        v-tooltip="t('backup.actions.cancel_backup')"
                        @click="$emit('cancel', item.id)"
                    >
                        <v-icon name="close" />
                    </v-button>
                </div>
                <div v-else class="action-buttons" @click.stop>
                    <v-button
                        v-if="exportEnabled"
                        icon rounded secondary small
                        v-tooltip="t('backup.actions.download')"
                        @click="$emit('download', item.id)"
                    >
                        <v-icon name="download" />
                    </v-button>
                    <v-button
                        v-if="item.status === 'success'"
                        icon rounded secondary small
                        :disabled="restoreDisabled"
                        v-tooltip="t('backup.actions.restore')"
                        @click="$emit('restore', item.id)"
                    >
                        <v-icon name="settings_backup_restore" />
                    </v-button>
                    <v-button
                        icon rounded secondary small
                        :disabled="deletingId === item.id"
                        :loading="deletingId === item.id"
                        v-tooltip="t('backup.actions.delete')"
                        @click="$emit('delete', item.id)"
                    >
                        <v-icon name="delete" />
                    </v-button>
                </div>
            </template>
        </v-table>

        <v-notice v-else type="info">{{ t('backup.notices.no_backups') }}</v-notice>
    </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { BackupManifest } from '../../shared/types.js';
import { formatSize, formatDate } from '../composables/useFormatters.js';

defineProps<{
    loading: boolean
    items: BackupManifest[]
    headers: Array<Record<string, unknown>>
    exportEnabled: boolean
    restoreDisabled?: boolean
    deletingId: string | null
    cancellingId: string | null
}>();

defineEmits<{
    rowClick: [payload: { item: BackupManifest }]
    headersUpdate: [headers: Array<{ value: string, width?: number }>]
    cancel: [id: string]
    download: [id: string]
    restore: [id: string]
    delete: [id: string]
}>();

const sort = defineModel<{ by: string, desc: boolean }>('sort', { required: true });

const { t } = useI18n();
</script>

<style scoped>
.backup-content {
    padding: var(--content-padding);
    padding-top: 0;
}

.center {
    display: flex;
    justify-content: center;
    padding: 4rem 0;
}

.label-cell {
    display: flex;
    align-items: center;
    gap: 0.375rem;
}

.source-icon {
    color: var(--theme--foreground-subdued);
}

.status-chip {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
}

.status-success {
    --v-chip-color: var(--success);
    --v-chip-background-color: var(--success-10);
}

.status-failed {
    --v-chip-color: var(--danger);
    --v-chip-background-color: var(--danger-10);
}

.status-running {
    --v-chip-color: var(--warning);
    --v-chip-background-color: var(--warning-10);
}

.restored-cell {
    color: var(--theme--foreground-subdued);
}

.restored-cell.restored-failed {
    color: var(--danger);
}

.restored-empty {
    color: var(--theme--foreground-subdued);
}

.restored-error-hint {
    color: var(--danger);
}

.action-buttons {
    display: flex;
    gap: 0.33rem;
}
</style>
