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
                :disabled="!canBackup || !canRestore || hasRunning || uploading"
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
                :disabled="!canBackup || hasRunning"
                @click="openCreateDialog"
            >
                <v-icon name="add" small />
            </v-button>
        </template>

        <div v-if="installationErrors.length" class="installation-banner">
            <v-notice type="danger">
                <p class="installation-title">{{ t('backup.installation.title') }}</p>
                <p>{{ t('backup.installation.intro') }}</p>
                <ul class="installation-list">
                    <li v-for="(issue, idx) in installationErrors" :key="idx">
                        <span>{{ formatInstallationIssue(issue).text }}</span>
                        <span v-if="formatInstallationIssue(issue).fix" class="installation-fix">
                            — {{ formatInstallationIssue(issue).fix }}
                        </span>
                    </li>
                </ul>
                <p class="installation-docs">{{ t('backup.installation.docs_hint') }}</p>
            </v-notice>
        </div>
        <div v-else-if="installationWarnings.length" class="installation-banner">
            <v-notice type="warning">
                <p class="installation-title">{{ t('backup.installation.warnings_title') }}</p>
                <ul class="installation-list">
                    <li v-for="(issue, idx) in installationWarnings" :key="idx">
                        <span>{{ formatInstallationIssue(issue).text }}</span>
                        <span v-if="formatInstallationIssue(issue).fix" class="installation-fix">
                            — {{ formatInstallationIssue(issue).fix }}
                        </span>
                    </li>
                </ul>
            </v-notice>
        </div>

        <template #navigation>
            <div class="nav-content">
                <StorageBar
                    v-if="storage"
                    :storage="storage"
                    :quota-m-b="config.quotaMB"
                    :min-free-m-b="config.minFreeMB"
                    :storage-percent="storagePercent"
                />
                <SettingsPanel
                    v-model:schedule="config.schedule"
                    v-model:retention="config.retention"
                    :config-loading="configLoading"
                    :schedule-options="scheduleOptions"
                    :retention-options="retentionOptions"
                    v-model:schedule-minute="scheduleMinuteInput"
                    v-model:schedule-hour="scheduleHourInput"
                    v-model:quota="quotaInput"
                    v-model:min-free="minFreeInput"
                    @save="saveConfig"
                    @save-schedule-offset="saveScheduleOffset"
                    @save-quota-fields="saveQuotaFields"
                    @configure-scope="showBackupScope = true"
                />
            </div>
        </template>

        <BackupTable
            :loading="loading"
            :items="sortedBackups"
            :headers="headers"
            :export-enabled="exportEnabled"
            :restore-disabled="!canRestore"
            :deleting-id="deletingId"
            :cancelling-id="cancellingId"
            v-model:sort="sortState"
            @row-click="onRowClick"
            @headers-update="onHeadersUpdate"
            @cancel="cancelBackup"
            @download="downloadBackup"
            @restore="restoreBackup"
            @delete="deleteBackup"
        />

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

        <CreateBackupDialog
            v-model="showCreateDialog"
            v-model:label="newLabel"
            :creating="creating"
            :scope="backupRunScope"
            :collections="collections"
            :relations="relations"
            :scope-empty="backupScopeEmpty"
            @create="createBackup"
            @update-scope="updateBackupRunScope"
        />

        <RestoreDialog
            v-model="showRestoreDialog"
            :manifest="pendingRestoreManifest"
            :backup-id="pendingRestoreId"
            :scope="restoreRunScope"
            :collections="restoreCollections"
            :relations="relations"
            :available-components="restoreComponents"
            :scope-empty="restoreScopeEmpty"
            :restore-disabled="!canRestore"
            @confirm="confirmRestore"
            @update-scope="updateRestoreRunScope"
        />

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
import { mergeBackupTranslations } from './translations.js';
import type { BackupManifest, RunScope } from '../shared/types.js';
import { useBackupTable } from './composables/useBackupTable.js';
import { useBackupApi } from './composables/useBackupApi.js';
import BackupDetailDialog from './components/BackupDetailDialog.vue';
import ScopeDialog from './components/ScopeDialog.vue';
import ActivitySidebar from './components/ActivitySidebar.vue';
import StorageBar from './components/StorageBar.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import BackupTable from './components/BackupTable.vue';
import CreateBackupDialog from './components/CreateBackupDialog.vue';
import RestoreDialog from './components/RestoreDialog.vue';

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
    canBackup, canRestore, installationErrors, installationWarnings, formatInstallationIssue,
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

.installation-banner {
    margin: 0 2rem 1rem;
}

.installation-title {
    margin: 0 0 0.5rem;
    font-weight: 600;
}

.installation-list {
    margin: 0.5rem 0 0;
    padding-left: 1.25rem;
}

.installation-fix {
    color: var(--theme--foreground-subdued);
}

.installation-docs {
    margin: 0.75rem 0 0;
    font-size: 0.875rem;
}

.nav-content {
    padding: 0 var(--content-padding-half, 0.75rem);
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
