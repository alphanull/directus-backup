/**
 * Mutating backup actions: create/delete/cancel, download, the upload+restore
 * flow, and config persistence. Operates on the shared {@link BackupData} state
 * and uses {@link BackupPolling} to (re)start polling after a backup is started.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import type { BackupManifest, RunScope } from '../../shared/types.js';
import type { BackupApiClient, Translate, BackupData } from './useBackupData.js';
import type { BackupPolling } from './usePolling.js';

const RESTORE_OVERLAY_TIMEOUT_MS = 15 * 60 * 1000;
const RESTORE_OVERLAY_POLL_MS = 3000;

/**
 * Creates the backup action functions bound to the shared state.
 * @param api      Directus API client.
 * @param t        Translator function.
 * @param data     Shared reactive state + fetchers + notice helpers.
 * @param polling  Polling controllers.
 * @returns        The action functions consumed by the module UI.
 */
// eslint-disable-next-line max-lines-per-function -- intentionally aggregates all backup UI actions
export function useBackupActions(api: BackupApiClient, t: Translate, data: BackupData, polling: BackupPolling) {
    const {
        backups, creating, deletingId, cancellingId, notice,
        showCreateDialog, newLabel, showDeleteDialog, pendingDeleteId,
        showRestoreDialog, pendingRestoreId, pendingRestoreManifest, restoring, uploading,
        config, backupRunScope, restoreRunScope, collections, canRestore,
        scheduleMinuteInput, scheduleHourInput, quotaInput, minFreeInput,
        translateError, showNotice, fetchList, fetchConfig, fetchStorage, fetchActivity
    } = data;
    const { startPolling } = polling;

    /** Persists the current config; reloads from the server on failure. */
    async function saveConfig() {
        try {
            await api.put('/backup-api/config', {
                schedule: config.schedule,
                scheduleMinute: config.scheduleMinute,
                scheduleHour: config.scheduleHour,
                retention: config.retention,
                quotaMB: config.quotaMB,
                minFreeMB: config.minFreeMB,
                backupScope: { ...config.backupScope }
            });
        } catch (e: unknown) {
            const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
            showNotice(msg || t('backup.notices.config_save_failed'), 'danger');
            await fetchConfig();
        }
    }

    /** Clamps and saves the schedule minute/hour offsets if they changed. */
    function saveScheduleOffset() {
        const m = Math.max(0, Math.min(59, parseInt(scheduleMinuteInput.value, 10) || 0));
        const h = Math.max(0, Math.min(23, parseInt(scheduleHourInput.value, 10) || 0));
        if (m === config.scheduleMinute && h === config.scheduleHour) return;
        config.scheduleMinute = m;
        config.scheduleHour = h;
        scheduleMinuteInput.value = String(m);
        scheduleHourInput.value = String(h);
        saveConfig();
    }

    /** Clamps and saves the quota / min-free values if they changed. */
    function saveQuotaFields() {
        const q = Math.max(0, parseInt(quotaInput.value, 10) || 0);
        const m = Math.max(0, parseInt(minFreeInput.value, 10) || 0);
        if (q === config.quotaMB && m === config.minFreeMB) return;
        config.quotaMB = q;
        config.minFreeMB = m;
        quotaInput.value = String(q);
        minFreeInput.value = String(m);
        saveConfig();
    }

    /** Opens the create dialog. Components prefill from the global scope; collections always start fully selected. */
    function openCreateDialog() {
        backupRunScope.database = config.backupScope.database;
        backupRunScope.assets = config.backupScope.assets;
        backupRunScope.extensions = config.backupScope.extensions;
        // Manual backups always start with every collection selected (full backup),
        // independent of the global config's excludedCollections blocklist.
        backupRunScope.includeCollections = [...collections.value];
        newLabel.value = '';
        showCreateDialog.value = true;
    }

    /**
     * Normalizes a run scope before sending to the API.
     * If every collection in `allCollections` is listed in `scope.includeCollections`,
     * the list is collapsed to [] so the backend uses a full dump/restore without
     * --table filters instead of the targeted path.
     */
    function normalizeRunScope(scope: RunScope, allCollections: string[]): RunScope {
        const allSelected = allCollections.length > 0 && allCollections.every(c => scope.includeCollections.includes(c));
        return { ...scope, includeCollections: allSelected ? [] : scope.includeCollections };
    }

    /** Triggers a new backup, refreshes state, and starts polling. */
    async function createBackup() {
        creating.value = true;
        notice.value = '';
        const label = newLabel.value.trim().replace(/[^a-zA-Z0-9_-]/g, '') || undefined;
        try {
            const scope = normalizeRunScope({ ...backupRunScope }, collections.value);
            await api.post('/backup-api/create', { label, scope });
            showCreateDialog.value = false;
            newLabel.value = '';
            await Promise.all([fetchList(), fetchStorage(), fetchActivity()]);
            startPolling();
        } catch (e: unknown) {
            const resp = (e as { response?: { status?: number, data?: Record<string, unknown> } })?.response;
            if (resp?.status === 409) {
                showNotice(translateError(resp?.data as any, t('backup.notices.already_running')), 'warning');
            } else {
                showNotice(translateError(resp?.data as any, t('backup.notices.create_failed')), 'danger');
            }
        } finally {
            creating.value = false;
        }
    }

    /** Opens the download endpoint for the given backup ID in a new tab. */
    function downloadBackup(id: string) {
        window.open(`/backup-api/${id}/download`, '_blank');
    }

    /** Uploads a selected `.tar.gz` archive and offers to restore it on success. */
    async function handleFileSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        if (!canRestore.value) {
            showNotice(t('backup.errors.INSTALL_INCOMPLETE'), 'danger');
            return;
        }

        uploading.value = true;
        notice.value = '';

        try {
            const { data: uploaded } = await api.post('/backup-api/upload', file, {
                headers: { 'Content-Type': 'application/gzip' }
            });
            await Promise.all([fetchList(), fetchStorage(), fetchActivity()]);
            if (uploaded?.id) {
                pendingRestoreId.value = uploaded.id;
                pendingRestoreManifest.value = (uploaded as BackupManifest) ?? null;
                initRestoreScope(pendingRestoreManifest.value);
                showRestoreDialog.value = true;
            }
        } catch (e: unknown) {
            const resp = (e as { response?: { status?: number, data?: Record<string, unknown> } })?.response;
            showNotice(translateError(resp?.data as any, t('backup.notices.upload_failed')), 'danger');
        } finally {
            uploading.value = false;
        }
    }

    /**
     * Initializes the per-run restore scope from a backup manifest.
     * Only collections that are also known to Directus are pre-selected;
     * extension tables (PostGIS etc.) are not user-configurable and are omitted.
     * Falls back to the full manifest list when the Directus collection list is
     * not yet loaded.
     */
    function initRestoreScope(manifest: BackupManifest | null) {
        const scope = manifest?.scope;
        restoreRunScope.database = scope?.database !== false;
        restoreRunScope.assets = scope?.assets !== false;
        restoreRunScope.extensions = scope?.extensions !== false;
        const allCollections = scope?.collections ? [...scope.collections] : [];
        restoreRunScope.includeCollections = collections.value.length > 0
            ? allCollections.filter(c => collections.value.includes(c))
            : allCollections;
    }

    /** Opens the restore confirmation dialog for the given backup ID. */
    function restoreBackup(id: string) {
        pendingRestoreId.value = id;
        pendingRestoreManifest.value = backups.value.find(b => b.id === id) ?? null;
        initRestoreScope(pendingRestoreManifest.value);
        showRestoreDialog.value = true;
    }

    /** Starts the restore, then polls until Directus restarts and redirects to login. */
    async function confirmRestore() {
        const id = pendingRestoreId.value;
        showRestoreDialog.value = false;
        if (!canRestore.value) {
            showNotice(t('backup.errors.INSTALL_INCOMPLETE'), 'danger');
            return;
        }
        restoring.value = true;

        try {
            const manifestCollections = pendingRestoreManifest.value?.scope?.collections ?? [];
            // Mirror the UI filter: only Directus-known collections count as "available".
            // Extension tables (PostGIS etc.) are not part of the user's selection.
            const availableCollections = collections.value.length > 0
                ? manifestCollections.filter(c => collections.value.includes(c))
                : manifestCollections;
            const scope = normalizeRunScope({ ...restoreRunScope }, availableCollections);
            await api.post(`/backup-api/${id}/restore`, { scope });
        } catch (e: unknown) {
            const resp = (e as { response?: { data?: Record<string, unknown> } })?.response;
            showNotice(translateError(resp?.data as any, t('backup.notices.restore_failed')), 'danger');
            restoring.value = false;
            return;
        }

        const deadline = Date.now() + RESTORE_OVERLAY_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await new Promise(r => { setTimeout(r, RESTORE_OVERLAY_POLL_MS); });
            try {
                await api.get('/backup-api/list');
                try { await api.post('/auth/logout'); } catch { /* ignore */ }
                window.location.href = '/admin/login';
                return;
            } catch (e: unknown) {
                const status = (e as { response?: { status?: number } })?.response?.status;
                if (status === 401 || status === 403) {
                    window.location.href = '/admin/login';
                    return;
                }
            }
        }
        restoring.value = false;
        showNotice(t('backup.notices.restore_poll_timeout'), 'warning');
    }

    /** Opens the delete confirmation dialog for the given backup ID. */
    function deleteBackup(id: string) {
        pendingDeleteId.value = id;
        showDeleteDialog.value = true;
    }

    /** Deletes the pending backup and refreshes state. */
    async function confirmDelete() {
        const id = pendingDeleteId.value;
        showDeleteDialog.value = false;
        deletingId.value = id;
        try {
            await api.delete(`/backup-api/${id}`);
            await Promise.all([fetchList(), fetchStorage(), fetchActivity()]);
        } catch (e: unknown) {
            const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
            showNotice(msg || t('backup.notices.delete_failed'), 'danger');
        } finally {
            deletingId.value = null;
        }
    }

    /** Cancels a running backup. The sidecar removes the partial directory automatically. */
    async function cancelBackup(id: string) {
        cancellingId.value = id;
        try {
            await api.post(`/backup-api/${id}/cancel`);
            await Promise.all([fetchList(), fetchActivity()]);
        } catch (e: unknown) {
            const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
            showNotice(msg || t('backup.notices.cancel_failed'), 'danger');
        } finally {
            cancellingId.value = null;
        }
    }

    return {
        saveConfig,
        saveScheduleOffset,
        saveQuotaFields,
        openCreateDialog,
        createBackup,
        downloadBackup,
        handleFileSelected,
        restoreBackup,
        confirmRestore,
        deleteBackup,
        confirmDelete,
        cancelBackup
    };
}
