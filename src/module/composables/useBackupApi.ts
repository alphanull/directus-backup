/**
 * Backup module orchestrator. Wires the reactive state ({@link useBackupData}),
 * the polling loops ({@link usePolling}), and the mutating actions
 * ({@link useBackupActions}) into the single flat object the module UI binds to.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { useBackupData, type BackupApiClient, type Translate } from './useBackupData.js';
import { usePolling } from './usePolling.js';
import { useBackupActions } from './useBackupActions.js';

/**
 * Creates the backup UI state together with the API actions that mutate it.
 * @param api  Directus API client.
 * @param t    Translator function.
 * @returns    The reactive state, computed values, and actions consumed by the module UI.
 */
export function useBackupApi(api: BackupApiClient, t: Translate) {
    const data = useBackupData(api, t);
    const polling = usePolling({
        fetchList: data.fetchList,
        fetchActivity: data.fetchActivity,
        fetchStorage: data.fetchStorage,
        hasRunning: data.hasRunning
    });
    const actions = useBackupActions(api, t, data, polling);

    /** Initial load of all data; starts appropriate polling based on current state. */
    async function init() {
        await data.fetchHealth();
        await Promise.all([
            data.fetchList(),
            data.fetchConfig(),
            data.fetchStorage(),
            data.fetchActivity(),
            data.fetchCollections(),
            data.fetchRelations()
        ]);
        if (data.hasRunning.value) polling.startPolling();
        else polling.startIdlePolling();
    }

    return {
        backups: data.backups,
        loading: data.loading,
        creating: data.creating,
        deletingId: data.deletingId,
        cancellingId: data.cancellingId,
        notice: data.notice,
        noticeType: data.noticeType,
        showErrorDialog: data.showErrorDialog,
        closeError: data.closeError,
        showCreateDialog: data.showCreateDialog,
        newLabel: data.newLabel,
        showDeleteDialog: data.showDeleteDialog,
        pendingDeleteId: data.pendingDeleteId,
        showRestoreDialog: data.showRestoreDialog,
        pendingRestoreId: data.pendingRestoreId,
        pendingRestoreManifest: data.pendingRestoreManifest,
        restoring: data.restoring,
        uploading: data.uploading,
        configLoading: data.configLoading,
        importEnabled: data.importEnabled,
        exportEnabled: data.exportEnabled,
        installationReport: data.installationReport,
        canBackup: data.canBackup,
        canRestore: data.canRestore,
        installationErrors: data.installationErrors,
        installationWarnings: data.installationWarnings,
        formatInstallationIssue: data.formatInstallationIssue,
        config: data.config,
        backupRunScope: data.backupRunScope,
        restoreRunScope: data.restoreRunScope,
        scheduleMinuteInput: data.scheduleMinuteInput,
        scheduleHourInput: data.scheduleHourInput,
        quotaInput: data.quotaInput,
        minFreeInput: data.minFreeInput,
        storage: data.storage,
        storagePercent: data.storagePercent,
        activity: data.activity,
        collections: data.collections,
        relations: data.relations,
        hasRunning: data.hasRunning,
        saveConfig: actions.saveConfig,
        saveScheduleOffset: actions.saveScheduleOffset,
        saveQuotaFields: actions.saveQuotaFields,
        openCreateDialog: actions.openCreateDialog,
        createBackup: actions.createBackup,
        downloadBackup: actions.downloadBackup,
        handleFileSelected: actions.handleFileSelected,
        restoreBackup: actions.restoreBackup,
        confirmRestore: actions.confirmRestore,
        deleteBackup: actions.deleteBackup,
        confirmDelete: actions.confirmDelete,
        cancelBackup: actions.cancelBackup,
        init,
        stopPolling: polling.stopPolling,
        stopIdlePolling: polling.stopIdlePolling
    };
}
