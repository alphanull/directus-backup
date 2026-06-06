<!--
  Main backup UI — three-panel layout with status/settings sidebar, backup
  table, and activity log; wires the composables to the Directus module view.

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <private-view :title="t('backup.title')">
        <template #title-outer:prepend>
            <div class="icon"><v-icon name="backup" small /></div>
        </template>

        <template #actions>
            <v-button
                v-if="importEnabled"
                v-tooltip.bottom="t('backup.actions.restore_from_file')"
                icon
                rounded
                secondary
                small
                :disabled="hasRunning || uploading"
                :loading="uploading"
                @click="triggerUpload"
            >
                <v-icon name="upload_file" small />
            </v-button>
            <v-button
                v-tooltip.bottom="t('backup.actions.create_backup')"
                icon
                rounded
                small
                :loading="creating"
                :disabled="hasRunning"
                @click="openCreateDialog"
            >
                <v-icon name="add" small />
            </v-button>
        </template>

        <template #navigation>
            <div class="nav-content">
                <div class="nav-section">
                    <div class="nav-section-title"><v-icon name="monitoring" class="nav-section-icon" />{{ t('backup.nav.status') }}</div>
                    <div v-if="storage" class="nav-storage">
                        <div class="nav-storage-row">
                            <span class="nav-storage-label">{{ t('backup.storage.used') }}</span>
                            <span>{{ storage.usedMB != null ? formatMB(storage.usedMB) : '?' }}<template v-if="config.quotaMB > 0"> / {{ formatMB(config.quotaMB) }}</template></span>
                        </div>
                        <div class="nav-storage-row">
                            <span class="nav-storage-label">{{ t('backup.storage.free') }}</span>
                            <span :class="{ 'storage-warn': storage.freeMB !== null && config.minFreeMB > 0 && storage.freeMB < config.minFreeMB }">
                                {{ storage.freeMB != null ? formatMB(storage.freeMB) : '?' }}
                            </span>
                        </div>
                        <div v-if="config.quotaMB > 0" class="storage-bar-track">
                            <div
                                class="storage-bar-fill"
                                :style="{ width: Math.min(storagePercent, 100) + '%', background: storageBarColor }"
                            />
                        </div>
                    </div>
                </div>

                <div class="nav-section">
                    <div class="nav-section-title"><v-icon name="settings" class="nav-section-icon" />{{ t('backup.nav.settings') }}</div>
                    <div class="nav-field">
                        <span class="nav-field-label">
                            {{ t('backup.settings.schedule') }}
                            <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.schedule')" />
                        </span>
                        <v-select
                            v-model="config.schedule"
                            :items="scheduleOptions"
                            :disabled="configLoading"
                            @update:model-value="saveConfig"
                        />
                    </div>
                    <div v-if="['1h','6h','12h'].includes(config.schedule)" class="nav-field">
                        <span class="nav-field-label">
                            {{ t('backup.settings.at_minute') }}
                            <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.at_minute')" />
                        </span>
                        <v-input
                            v-model="scheduleMinuteInput"
                            type="number"
                            :min="0"
                            :max="59"
                            placeholder="0"
                            :disabled="configLoading"
                            @blur="saveScheduleOffset"
                            @keyup.enter="($event.target as HTMLInputElement)?.blur()"
                        />
                    </div>
                    <div v-if="['daily','3d','weekly'].includes(config.schedule)" class="nav-field">
                        <span class="nav-field-label">
                            {{ t('backup.settings.at_hour') }}<v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.at_hour')" />
                        </span>
                        <v-input
                            v-model="scheduleHourInput"
                            type="number"
                            :min="0"
                            :max="23"
                            placeholder="0"
                            :disabled="configLoading"
                            @blur="saveScheduleOffset"
                            @keyup.enter="($event.target as HTMLInputElement)?.blur()"
                        />
                    </div>
                    <div class="nav-field">
                        <span class="nav-field-label">
                            {{ t('backup.settings.retention') }}
                            <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.retention')" />
                        </span>
                        <v-select
                            v-model="config.retention"
                            :items="retentionOptions"
                            :disabled="configLoading"
                            @update:model-value="saveConfig"
                        />
                    </div>
                    <div class="nav-field">
                        <span class="nav-field-label">
                            {{ t('backup.settings.quota_mb') }}
                            <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.quota_mb')" />
                        </span>
                        <v-input
                            v-model="quotaInput"
                            type="number"
                            :min="0"
                            :placeholder="t('backup.settings.quota_placeholder')"
                            :disabled="configLoading"
                            @blur="saveQuotaFields"
                            @keyup.enter="($event.target as HTMLInputElement)?.blur()"
                        />
                    </div>
                    <div class="nav-field">
                        <span class="nav-field-label">
                            {{ t('backup.settings.min_free_mb') }}
                            <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.min_free_mb')" />
                        </span>
                        <v-input
                            v-model="minFreeInput"
                            type="number"
                            :min="0"
                            placeholder="100"
                            :disabled="configLoading"
                            @blur="saveQuotaFields"
                            @keyup.enter="($event.target as HTMLInputElement)?.blur()"
                        />
                    </div>
                </div>

                <div class="nav-scope-buttons">
                    <span class="nav-field-label">
                        {{ t('backup.settings.backup_scope') }}
                        <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.backup_scope')" />
                    </span>
                    <v-button secondary full-width @click="showBackupScope = true">
                        {{ t('backup.actions.configure') }}
                    </v-button>
                </div>
            </div>
        </template>

        <div class="backup-content">
            <div v-if="loading && backups.length === 0" class="center">
                <v-progress-circular indeterminate />
            </div>

            <v-table
                v-else-if="backups.length > 0"
                :headers="headers"
                :items="sortedBackups"
                item-key="id"
                :loading="loading"
                v-model:sort="sortState"
                must-sort
                show-resize
                @update:headers="onHeadersUpdate"
                @click:row="onRowClick"
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
                            @click="cancelBackup(item.id)"
                        >
                            <v-icon name="close" />
                        </v-button>
                    </div>
                    <div v-else class="action-buttons" @click.stop>
                        <v-button
                            v-if="exportEnabled"
                            icon rounded secondary small
                            v-tooltip="t('backup.actions.download')"
                            @click="downloadBackup(item.id)"
                        >
                            <v-icon name="download" />
                        </v-button>
                        <v-button
                            v-if="item.status === 'success'"
                            icon rounded secondary small
                            v-tooltip="t('backup.actions.restore')"
                            @click="restoreBackup(item.id)"
                        >
                            <v-icon name="settings_backup_restore" />
                        </v-button>
                        <v-button
                            icon rounded secondary small
                            :disabled="deletingId === item.id"
                            :loading="deletingId === item.id"
                            v-tooltip="t('backup.actions.delete')"
                            @click="deleteBackup(item.id)"
                        >
                            <v-icon name="delete" />
                        </v-button>
                    </div>
                </template>
            </v-table>

            <v-notice v-else type="info">{{ t('backup.notices.no_backups') }}</v-notice>
        </div>

        <!-- Delete confirmation -->
        <v-dialog v-model="showDeleteDialog" @esc="showDeleteDialog = false">
            <v-card>
                <v-card-title>{{ t('backup.dialogs.delete_title') }}</v-card-title>
                <v-card-text>{{ t('backup.dialogs.delete_confirm', { id: pendingDeleteId }) }}</v-card-text>
                <v-card-actions>
                    <v-button secondary @click="showDeleteDialog = false">{{ t('backup.actions.cancel') }}</v-button>
                    <v-button kind="danger" :loading="deletingId === pendingDeleteId" @click="confirmDelete">{{ t('backup.actions.delete') }}</v-button>
                </v-card-actions>
            </v-card>
        </v-dialog>

        <!-- Create dialog -->
        <v-dialog v-model="showCreateDialog" @esc="showCreateDialog = false">
            <v-card>
                <v-card-title>{{ t('backup.dialogs.create_title') }}</v-card-title>
                <v-card-text>
                    <v-input
                        v-model="newLabel"
                        :placeholder="t('backup.settings.label_placeholder')"
                        :maxlength="32"
                    />
                    <div class="create-scope">
                        <div class="create-scope-label">{{ t('backup.scope.title_create') }}</div>
                        <ScopeFields
                            mode="backup"
                            :scope="backupRunScope"
                            :collections="collections"
                            :relations="relations"
                            @update="updateBackupRunScope"
                        />
                    </div>
                </v-card-text>
                <v-card-actions>
                    <v-button secondary @click="showCreateDialog = false">{{ t('backup.actions.cancel') }}</v-button>
                    <v-button :loading="creating" :disabled="backupScopeEmpty" @click="createBackup">{{ t('backup.actions.create') }}</v-button>
                </v-card-actions>
            </v-card>
        </v-dialog>

        <!-- Restore confirmation dialog -->
        <v-dialog v-model="showRestoreDialog" @esc="showRestoreDialog = false">
            <v-card>
                <v-card-title>{{ t('backup.dialogs.restore_title', { label: pendingRestoreManifest?.label ?? pendingRestoreId }) }}</v-card-title>
                <v-card-text>
                    <div class="create-scope">
                        <div class="create-scope-label">{{ t('backup.scope.title_restore') }}</div>
                        <ScopeFields
                            mode="restore"
                            :scope="restoreRunScope"
                            :collections="restoreCollections"
                            :relations="relations"
                            :available-components="restoreComponents"
                            @update="updateRestoreRunScope"
                        />
                    </div>
                    <v-notice type="warning" style="margin-top: 0.75rem;">
                        {{ t('backup.dialogs.restore_warning') }}
                    </v-notice>
                </v-card-text>
                <v-card-actions>
                    <v-button secondary @click="showRestoreDialog = false">{{ t('backup.actions.cancel') }}</v-button>
                    <v-button kind="danger" :disabled="restoreScopeEmpty" @click="confirmRestore">{{ t('backup.actions.restore') }}</v-button>
                </v-card-actions>
            </v-card>
        </v-dialog>

        <!-- Error dialog -->
        <v-dialog v-model="showErrorDialog" @esc="closeError">
            <v-card :class="`notice-card notice-card--${noticeType}`">
                <v-card-title>
                    <v-icon :name="noticeType === 'danger' ? 'error' : noticeType === 'warning' ? 'warning' : 'info'" class="notice-card-icon" />
                    {{ t('backup.dialogs.error_title') }}
                </v-card-title>
                <v-card-text>{{ notice }}</v-card-text>
                <v-card-actions>
                    <v-button @click="closeError">{{ t('backup.actions.close') }}</v-button>
                </v-card-actions>
            </v-card>
        </v-dialog>

        <BackupDetailDialog v-model="showDetailDialog" :item="detailItem" />

        <ScopeDialog
            v-model="showBackupScope"
            :title="t('backup.scope.title_backup')"
            :hint="t('backup.scope.default_scope_hint')"
            :scope="backupScopeForDialog"
            :collections="collections"
            :relations="relations"
            @save="onSaveBackupScope"
        />

        <input
            v-if="importEnabled"
            ref="uploadFileInput"
            type="file"
            accept=".gz,.tgz"
            style="display: none;"
            @change="handleFileSelected"
        />

        <template #sidebar>
            <sidebar-detail id="activity" :title="t('backup.activity.title')" icon="history">
                <ActivitySidebar :activity="activity" />
            </sidebar-detail>
        </template>

        <!-- Restore overlay -->
        <teleport to="body">
            <div v-if="restoring" class="restore-overlay">
                <div class="restore-overlay-box">
                    <v-progress-circular indeterminate class="restore-spinner" />
                    <p class="restore-title">{{ t('backup.overlay.title') }}</p>
                    <p class="restore-hint">{{ t('backup.overlay.hint_restart') }}<br>{{ t('backup.overlay.hint_reload') }}</p>
                </div>
            </div>
        </teleport>
    </private-view>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useApi } from '@directus/extensions-sdk';
import { mergeBackupTranslations } from '../shared/translations.js';
import type { BackupManifest, RunScope } from '../shared/types.js';
import { formatSize, formatMB, formatDate } from './composables/useFormatters.js';
import { useBackupTable } from './composables/useBackupTable.js';
import { useBackupApi } from './composables/useBackupApi.js';
import BackupDetailDialog from './components/BackupDetailDialog.vue';
import ScopeDialog from './components/ScopeDialog.vue';
import ScopeFields from './components/ScopeFields.vue';
import ActivitySidebar from './components/ActivitySidebar.vue';

const i18n = useI18n();
const { t } = i18n;
mergeBackupTranslations(i18n);

const api = useApi();
const uploadFileInput = ref<HTMLInputElement | null>(null);
const showDetailDialog = ref(false);
const detailItem = ref<BackupManifest | null>(null);
const showBackupScope = ref(false);

const {
    backups, loading, creating, deletingId, cancellingId,
    notice, noticeType, showErrorDialog, closeError,
    showCreateDialog, newLabel,
    showDeleteDialog, pendingDeleteId,
    showRestoreDialog, pendingRestoreId, pendingRestoreManifest,
    restoring, uploading, configLoading,
    importEnabled, exportEnabled,
    config, backupRunScope, restoreRunScope,
    scheduleMinuteInput, scheduleHourInput, quotaInput, minFreeInput,
    storage, storagePercent, activity, collections, relations, hasRunning,
    saveConfig, saveScheduleOffset, saveQuotaFields,
    openCreateDialog, createBackup, downloadBackup, handleFileSelected,
    restoreBackup, confirmRestore,
    deleteBackup, confirmDelete, cancelBackup,
    init, stopPolling, stopIdlePolling
} = useBackupApi(api, t);

// Global scope config stores exclusions; ScopeDialog works with inclusions.
// Convert on the way in (excludedCollections → includeCollections for dialog)
// and on the way out (dialog's includeCollections → excludedCollections for storage).
const backupScopeForDialog = computed<RunScope>(() => ({
    database: config.backupScope.database,
    assets: config.backupScope.assets,
    extensions: config.backupScope.extensions,
    // Derive inclusions from exclusions; new/unknown collections default to included.
    includeCollections: config.backupScope.excludedCollections.length > 0
        ? collections.value.filter(c => !config.backupScope.excludedCollections.includes(c))
        : [...collections.value]
}));

// Restore dialog draws from the backup manifest's positive collection index,
// filtered to only Directus-known collections. Extension tables (e.g. PostGIS)
// are not user-configurable and are excluded from the selection UI; they are
// still restored on a full restore (pg_restore without --table filter).
const restoreCollections = computed(() => {
    const manifestCollections = pendingRestoreManifest.value?.scope?.collections ?? [];
    if (collections.value.length === 0) return manifestCollections;
    return manifestCollections.filter(c => collections.value.includes(c));
});
const restoreComponents = computed(() => {
    const scope = pendingRestoreManifest.value?.scope;
    const out: Array<'database' | 'assets' | 'extensions'> = [];
    if (scope?.database !== false) out.push('database');
    if (scope?.assets !== false) out.push('assets');
    if (scope?.extensions !== false) out.push('extensions');
    return out;
});

const {
    sortState, sortedBackups, headers, onHeadersUpdate,
    scheduleOptions, retentionOptions
} = useBackupTable(backups, t);

// Both scopes are pre-populated with all collections selected (openCreateDialog /
// initRestoreScope), so an empty includeCollections here unambiguously means the
// user deselected every collection — which must disable the action.
const backupScopeEmpty = computed(() => {
    if (!backupRunScope.database && !backupRunScope.assets && !backupRunScope.extensions) return true;
    return backupRunScope.database && collections.value.length > 0 && backupRunScope.includeCollections.length === 0;
});
const restoreScopeEmpty = computed(() => {
    if (!restoreRunScope.database && !restoreRunScope.assets && !restoreRunScope.extensions) return true;
    return restoreRunScope.database && restoreCollections.value.length > 0 && restoreRunScope.includeCollections.length === 0;
});

const storageBarColor = computed(() => {
    const p = Math.min(storagePercent.value, 100);
    if (p <= 50) return 'hsl(120, 65%, 45%)';
    const ratio = (p - 50) / 50;
    const hue = Math.round(120 * (1 - ratio));
    return `hsl(${hue}, 65%, 50%)`;
});

/**
 * Opens the hidden file input to start an upload.
 */
function triggerUpload() {
    uploadFileInput.value?.click();
}

/**
 * Opens the detail dialog for the clicked backup row.
 */
function onRowClick({ item }: { item: BackupManifest }) {
    detailItem.value = item;
    showDetailDialog.value = true;
}

/**
 * Applies and persists the selected backup scope.
 * ScopeDialog emits includeCollections; we convert to excludedCollections for storage
 * so new collections are automatically included when they appear later.
 * Empty includeCollections means "all selected" (ScopeDialog normalization) — nothing excluded.
 */
function onSaveBackupScope(scope: { database: boolean, assets: boolean, extensions: boolean, includeCollections: string[] }) {
    config.backupScope.database = scope.database;
    config.backupScope.assets = scope.assets;
    config.backupScope.extensions = scope.extensions;
    config.backupScope.excludedCollections = scope.includeCollections.length === 0
        ? []
        : collections.value.filter(c => !scope.includeCollections.includes(c));
    saveConfig();
}

/**
 * Applies a partial per-run scope update from the create dialog's ScopeFields.
 */
function updateBackupRunScope(patch: Partial<RunScope>) {
    Object.assign(backupRunScope, patch);
}

/**
 * Applies a partial per-run scope update from the restore dialog's ScopeFields.
 */
function updateRestoreRunScope(patch: Partial<RunScope>) {
    Object.assign(restoreRunScope, patch);
}

onMounted(init);
onUnmounted(() => {
    stopPolling();
    stopIdlePolling();
});
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

.icon {
    --v-icon-color: var(--theme--foreground);

    display: flex;
    justify-content: center;
    align-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: var(--theme--background-normal);
}

.nav-content {
    padding: 0 var(--content-padding-half, 0.75rem);
}

.nav-section {
    padding: 0.75rem 0;
}

.nav-section + .nav-section {
    border-top: 0.063rem solid var(--theme--border-color-subdued);
}

.nav-section-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--theme--foreground);
}

.nav-section-icon {
    --v-icon-color: var(--theme--foreground);
    --v-icon-size: 1.25rem;
}

.nav-storage {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.813rem;
    color: var(--theme--foreground-subdued);
}

.nav-storage-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.nav-storage-label {
    font-weight: 600;
}

.nav-field {
    margin-bottom: 0.75rem;
}

.nav-field:last-child {
    margin-bottom: 0;
}

.nav-field-label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 0.25rem;
    font-size: 0.813rem;
    font-weight: 600;
    color: var(--theme--foreground-subdued);
}

.nav-field-help {
    --v-icon-size: 1rem;
    --v-icon-color: var(--theme--foreground-subdued);

    flex-shrink: 0;
    opacity: 0.5;
    cursor: help;
    transition: opacity 0.15s;
}

.nav-field-help:hover {
    opacity: 1;
}

.nav-scope-buttons {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0;
    border-top: 0.063rem solid var(--theme--border-color-subdued);
}

.create-scope {
    margin-top: 1rem;
}

.create-scope-label {
    margin-bottom: 0.75rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--theme--foreground);
}

.storage-warn {
    font-weight: 600;
    color: var(--danger);
}

.storage-bar-track {
    overflow: hidden;
    height: 0.375rem;
    margin-top: 0.5rem;
    border-radius: 0.188rem;
    background: var(--theme--border-color-subdued);
}

.storage-bar-fill {
    height: 100%;
    border-radius: 0.188rem;
    transition: width 0.3s ease, background 0.3s ease;
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

:deep(.v-card-title) {
    margin-bottom: var(--content-padding);
    padding-bottom: var(--content-padding);
    padding-block-start: 0.438rem;
    border-bottom: 0.063rem solid var(--theme--border-color, var(--border-normal));
    font-size: 1.25rem;
}

.notice-card {
    border-top: 0.188rem solid transparent;
}

.notice-card--danger {
    border-top-color: var(--danger);
}

.notice-card--warning {
    border-top-color: var(--warning);
}

.notice-card--info {
    border-top-color: var(--primary);
}

.notice-card-icon {
    vertical-align: middle;
    margin-right: 0.5rem;
}

.notice-card--danger .notice-card-icon {
    --v-icon-color: var(--danger);
}

.notice-card--warning .notice-card-icon {
    --v-icon-color: var(--warning);
}

.notice-card--info .notice-card-icon {
    --v-icon-color: var(--primary);
}

.restore-overlay {
    position: fixed;
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 9999;
    background: var(--theme--background, #fff);
    inset: 0;
}

.restore-overlay-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    max-width: 32.5rem;
    padding: 0 1.5rem;
    text-align: center;
}

.restore-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--theme--foreground);
}

.restore-hint {
    font-size: 0.875rem;
    color: var(--theme--foreground-subdued);
    line-height: 1.6;
}
</style>
