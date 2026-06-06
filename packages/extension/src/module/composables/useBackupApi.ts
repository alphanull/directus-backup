/**
 * Backup module API composable — wraps every `/backup-api/*` call and owns the
 * reactive UI state (backups, config, storage, activity) plus polling control.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { ref, reactive, computed, watch } from 'vue';
import type { BackupManifest, RunScope } from '../../shared/types.js';
import type { ActivityEntry } from '../../shared/activity.js';

/**
 * Creates the backup UI state together with the API actions that mutate it.
 * Returns the reactive state refs and action functions consumed by the module UI.
 */
// eslint-disable-next-line max-lines-per-function -- composable intentionally aggregates all backup UI state and actions
export function useBackupApi(api: { get: Function, post: Function, put: Function, delete: Function }, t: (key: string, params?: Record<string, string | number>) => string) {
    const backups = ref<BackupManifest[]>([]);
    const loading = ref(true);
    const creating = ref(false);
    const deletingId = ref<string | null>(null);
    const cancellingId = ref<string | null>(null);
    const notice = ref('');
    const noticeType = ref<'info' | 'warning' | 'danger'>('info');
    const showErrorDialog = ref(false);
    const showCreateDialog = ref(false);
    const newLabel = ref('');
    watch(newLabel, val => { if (val.includes(' ')) newLabel.value = val.replace(/ /g, '-'); });
    const showDeleteDialog = ref(false);
    const pendingDeleteId = ref('');
    const showRestoreDialog = ref(false);
    const pendingRestoreId = ref('');
    const pendingRestoreManifest = ref<BackupManifest | null>(null);
    const restoring = ref(false);
    const uploading = ref(false);
    const configLoading = ref(false);
    // Operator-controlled feature flags from the sidecar; default hidden until the
    // server confirms they are enabled (secure-by-default).
    const importEnabled = ref(false);
    const exportEnabled = ref(false);
    const activity = ref<ActivityEntry[]>([]);
    const collections = ref<string[]>([]);
    const relations = ref<Array<{ collection: string, related_collection: string }>>([]);
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;

    const config = reactive({
        schedule: 'off',
        scheduleMinute: 0,
        scheduleHour: 0,
        retention: 'all',
        quotaMB: 0,
        minFreeMB: 100,
        backupScope: { database: true, assets: true, extensions: false, excludedCollections: [] as string[] }
    });

    // Per-run scope selections (one-off, not persisted to the global config).
    const backupRunScope = reactive<RunScope>({ database: true, assets: true, extensions: false, includeCollections: [] });
    const restoreRunScope = reactive<RunScope>({ database: true, assets: true, extensions: false, includeCollections: [] });
    const scheduleMinuteInput = ref('0');
    const scheduleHourInput = ref('0');
    const quotaInput = ref('0');
    const minFreeInput = ref('100');
    const storage = ref<{ usedMB: number | null, freeMB: number | null } | null>(null);

    const storagePercent = computed(() => {
        if (!storage.value?.usedMB || config.quotaMB <= 0) return 0;
        return Math.round(storage.value.usedMB / config.quotaMB * 100);
    });

    const hasRunning = computed(() => backups.value.some(b => b.status === 'running'));

    /** Translates a sidecar error code to a localized message, or falls back to the raw message. */
    function translateError(data: { code?: string, error?: string, usedMB?: number, importMB?: number, quotaMB?: number, freeMB?: number, minFreeMB?: number } | undefined, fallback: string): string {
        if (!data?.code) return data?.error || fallback;
        const key = `backup.errors.${data.code}`;
        const params: Record<string, string | number> = {};
        if (data.usedMB !== undefined) params.used = data.usedMB;
        if (data.importMB !== undefined) params.import = data.importMB;
        if (data.quotaMB !== undefined) params.quota = data.quotaMB;
        if (data.freeMB !== undefined) params.free = data.freeMB;
        if (data.minFreeMB !== undefined) params.min = data.minFreeMB;
        const translated = t(key, params);
        return translated === key ? data.error || fallback : translated;
    }

    /** Shows an error dialog that the user must explicitly dismiss. */
    function showNotice(msg: string, type: 'info' | 'warning' | 'danger' = 'info') {
        notice.value = msg;
        noticeType.value = type;
        showErrorDialog.value = true;
    }

    /** Dismisses the error dialog and clears the message. */
    function closeError() {
        showErrorDialog.value = false;
        notice.value = '';
    }

    /** Loads the backup list into `backups`. */
    async function fetchList() {
        try {
            const { data } = await api.get('/backup-api/list');
            backups.value = data ?? [];
        } catch (e: unknown) {
            const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
            showNotice(msg || t('backup.notices.load_failed'), 'danger');
        } finally {
            loading.value = false;
        }
    }

    /** Loads schedule/retention/quota/scope config and syncs the input fields. */
    async function fetchConfig() {
        try {
            configLoading.value = true;
            const { data } = await api.get('/backup-api/config');
            if (data?.schedule) config.schedule = data.schedule;
            if (data?.scheduleMinute !== undefined) config.scheduleMinute = data.scheduleMinute;
            if (data?.scheduleHour !== undefined) config.scheduleHour = data.scheduleHour;
            if (data?.retention) config.retention = data.retention;
            if (data?.quotaMB !== undefined) config.quotaMB = data.quotaMB;
            if (data?.minFreeMB !== undefined) config.minFreeMB = data.minFreeMB;
            if (data?.importEnabled !== undefined) importEnabled.value = data.importEnabled;
            if (data?.exportEnabled !== undefined) exportEnabled.value = data.exportEnabled;
            if (data?.backupScope) Object.assign(config.backupScope, data.backupScope);
            scheduleMinuteInput.value = String(config.scheduleMinute);
            scheduleHourInput.value = String(config.scheduleHour);
            quotaInput.value = String(config.quotaMB);
            minFreeInput.value = String(config.minFreeMB);
        } catch {
            // Config might not be available yet
        } finally {
            configLoading.value = false;
        }
    }

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

    /** Loads used/free storage figures (non-critical). */
    async function fetchStorage() {
        try {
            const { data } = await api.get('/backup-api/storage');
            storage.value = { usedMB: data?.usedMB ?? null, freeMB: data?.freeMB ?? null };
        } catch {
            // Storage info not critical
        }
    }

    /** Loads the latest activity-log entries (non-critical). */
    async function fetchActivity() {
        try {
            const { data } = await api.get('/backup-api/activity?limit=50');
            activity.value = data ?? [];
        } catch {
            // Activity log not critical
        }
    }

    /** Loads collection names for the exclude-scope selector. */
    async function fetchCollections() {
        try {
            const { data } = await api.get('/collections');
            collections.value = (data?.data ?? data ?? [])
                .map((c: { collection?: string }) => c.collection)
                .filter((n: unknown): n is string => typeof n === 'string')
                .sort();
        } catch {
            // Collections not critical for core functionality
        }
    }

    /** Loads relation pairs used to expand excluded collections. */
    async function fetchRelations() {
        try {
            const { data } = await api.get('/relations');
            relations.value = (data?.data ?? data ?? [])
                .filter((r: Record<string, unknown>) => r.collection && r.related_collection)
                .map((r: Record<string, unknown>) => ({
                    collection: String(r.collection),
                    related_collection: String(r.related_collection)
                }));
        } catch {
            // Relations not critical
        }
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

        uploading.value = true;
        notice.value = '';

        try {
            const { data } = await api.post('/backup-api/upload', file, {
                headers: { 'Content-Type': 'application/gzip' }
            });
            await Promise.all([fetchList(), fetchStorage(), fetchActivity()]);
            if (data?.id) {
                pendingRestoreId.value = data.id;
                pendingRestoreManifest.value = (data as BackupManifest) ?? null;
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
            const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
            showNotice(msg || t('backup.notices.restore_failed'), 'danger');
            restoring.value = false;
            return;
        }

        const poll = async() => {
            await new Promise(r => { setTimeout(r, 3000); });
            try {
                await api.get('/backup-api/list');
                try { await api.post('/auth/logout'); } catch { /* ignore */ }
                window.location.href = '/admin/login';
            } catch (e: unknown) {
                const status = (e as { response?: { status?: number } })?.response?.status;
                if (status === 401 || status === 403) {
                    window.location.href = '/admin/login';
                } else {
                    poll();
                }
            }
        };
        poll();
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

    /** Starts 5s polling while an operation runs; stops itself once idle. Pauses idle polling while active. */
    function startPolling() {
        if (pollTimer) return;
        stopIdlePolling();
        pollTimer = setInterval(async() => {
            const wasRunning = hasRunning.value;
            await Promise.all([fetchList(), fetchActivity()]);
            if (!hasRunning.value) {
                stopPolling();
                if (wasRunning) await fetchStorage();
                startIdlePolling();
            }
        }, 5000);
    }

    /** Stops the active polling timer. */
    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    /** Starts 30s idle polling to pick up background changes (for example, scheduled backups). */
    function startIdlePolling() {
        if (idleTimer) return;
        idleTimer = setInterval(async() => {
            if (hasRunning.value) {
                stopIdlePolling();
                startPolling();
                return;
            }
            await fetchList();
            if (hasRunning.value) {
                stopIdlePolling();
                startPolling();
            }
        }, 30000);
    }

    /** Stops the idle polling timer. */
    function stopIdlePolling() {
        if (idleTimer) {
            clearInterval(idleTimer);
            idleTimer = null;
        }
    }

    /** Initial load of all data; starts appropriate polling based on current state. */
    async function init() {
        await Promise.all([fetchList(), fetchConfig(), fetchStorage(), fetchActivity(), fetchCollections(), fetchRelations()]);
        if (hasRunning.value) startPolling();
        else startIdlePolling();
    }

    return {
        backups,
        loading,
        creating,
        deletingId,
        cancellingId,
        notice,
        noticeType,
        showErrorDialog,
        closeError,
        showCreateDialog,
        newLabel,
        showDeleteDialog,
        pendingDeleteId,
        showRestoreDialog,
        pendingRestoreId,
        pendingRestoreManifest,
        restoring,
        uploading,
        configLoading,
        importEnabled,
        exportEnabled,
        config,
        backupRunScope,
        restoreRunScope,
        scheduleMinuteInput,
        scheduleHourInput,
        quotaInput,
        minFreeInput,
        storage,
        storagePercent,
        activity,
        collections,
        relations,
        hasRunning,
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
        cancelBackup,
        init,
        stopPolling,
        stopIdlePolling
    };
}
