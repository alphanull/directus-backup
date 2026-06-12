<!--
  Activity log sidebar — renders recent backup/restore events with status icons
  and relative timestamps.

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <div v-if="activity.length === 0" class="activity-empty">
        {{ t('backup.activity.empty') }}
    </div>
    <div v-else class="activity-list">
        <div v-for="(entry, idx) in activity" :key="idx" class="activity-item">
            <v-icon :name="activityIcon(entry.action)" class="activity-icon" :class="activityIconClass(entry.action)" />
            <div class="activity-body">
                <div class="activity-header">
                    <span class="activity-action">{{ activityLabel(entry.action) }}</span>
                    <span class="activity-time">{{ formatRelativeTime(entry.timestamp) }}</span>
                </div>
                <div v-if="entry.backupId" class="activity-meta">
                    <span class="activity-id">{{ entry.backupId }}</span>
                </div>
                <span v-if="entry.detail" class="activity-detail">{{ entry.detail }}</span>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">

import { useI18n } from 'vue-i18n';
import type { ActivityEntry } from '../../shared/types.js';
import { formatRelativeTime } from '../composables/useFormatters.js';

defineProps<{
    activity: ActivityEntry[]
}>();

const { t } = useI18n();

/**
 * Maps an activity action to its Material icon name.
 */
function activityIcon(action: string): string {
    const map: Record<string, string> = {
        backup_success: 'check_circle',
        backup_failed: 'error',
        backup_cancelled: 'cancel',
        delete: 'delete',
        upload: 'upload_file',
        restore_success: 'settings_backup_restore',
        restore_failed: 'error',
        config: 'settings',
        error: 'error'
    };
    return map[action] ?? 'info';
}

/**
 * Maps an activity action to its status color CSS class.
 */
function activityIconClass(action: string): string {
    if (action.endsWith('_failed') || action === 'error') return 'activity-icon-danger';
    if (action === 'delete') return 'activity-icon-warning';
    if (action.endsWith('_success') || action === 'upload') return 'activity-icon-success';
    return '';
}

/**
 * Returns the translated label for an action, or the raw action as fallback.
 */
function activityLabel(action: string): string {
    const key = `backup.activity.${action}`;
    const val = t(key);
    return val === key ? action : val;
}
</script>

<style scoped>
.activity-list {
    display: flex;
    flex-direction: column;
}

.activity-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0;
    border-bottom: 0.063rem solid var(--theme--border-color-subdued);
}

.activity-item:last-child {
    border-bottom: none;
}

.activity-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
}

.activity-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
}

.activity-action {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--theme--foreground);
}

.activity-time {
    font-size: 0.813rem;
    color: var(--theme--foreground-subdued);
    white-space: nowrap;
}

.activity-icon {
    --v-icon-color: var(--theme--foreground-subdued);
    --v-icon-size: 1.5rem;

    flex-shrink: 0;
    margin-top: 0.063rem;
}

.activity-icon-success {
    --v-icon-color: var(--success);
}

.activity-icon-warning {
    --v-icon-color: var(--warning);
}

.activity-icon-danger {
    --v-icon-color: var(--danger);
}

.activity-meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
}

.activity-id {
    overflow: hidden;
    font-family: var(--theme--fonts--monospace--font-family, monospace);
    font-size: 0.75rem;
    color: var(--theme--foreground-subdued);
    white-space: nowrap;
    text-overflow: ellipsis;
}

.activity-detail {
    font-size: 0.75rem;
    color: var(--theme--foreground-subdued);
}

.activity-empty {
    padding: 0.75rem;
    font-size: 0.813rem;
    font-style: italic;
    color: var(--theme--foreground-subdued);
}
</style>
