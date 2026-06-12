/**
 * Reactive state for the backup module plus the read-only API fetchers and the
 * notice/error helpers. Owns every ref/`reactive` the UI binds to; actions and
 * polling receive this object and mutate it.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { ref, reactive, computed, watch } from 'vue';
import type { BackupManifest, RunScope, SanityReport, SanityIssue, ActivityEntry } from '../../shared/types.js';

/** API client shape provided by the Directus app SDK. */
export interface BackupApiClient { get: Function, post: Function, put: Function, delete: Function }

/** Translator function provided by the Directus app SDK. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * Creates the reactive backup state together with the fetchers and notice
 * helpers that read it.
 * @param api  Directus API client.
 * @param t    Translator function.
 * @returns    Reactive state, fetchers, and notice helpers.
 */
// eslint-disable-next-line max-lines-per-function -- intentionally aggregates all backup UI state and fetchers
export function useBackupData(api: BackupApiClient, t: Translate) {
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
    const installationReport = ref<SanityReport | null>(null);
    const activity = ref<ActivityEntry[]>([]);
    const collections = ref<string[]>([]);
    const relations = ref<Array<{ collection: string, related_collection: string }>>([]);

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
    const canBackup = computed(() => installationReport.value?.operational !== false);
    const canRestore = computed(() => installationReport.value?.restoreReady !== false);
    const installationErrors = computed(() => (installationReport.value?.issues ?? []).filter(i => i.severity === 'error'));
    const installationWarnings = computed(() => (installationReport.value?.issues ?? []).filter(i => i.severity === 'warning'));

    /** Localizes a sanity issue, falling back to the server-provided English text. */
    function formatInstallationIssue(issue: SanityIssue): { text: string, fix?: string } {
        const key = `backup.installation.issues.${issue.code}`;
        const text = t(key, issue.params || {});
        const fix = translateInstallationFix(issue);
        return {
            text: text === key ? issue.message : text,
            fix
        };
    }

    /** Localizes an installation fix hint, falling back to the server-provided hint. */
    function translateInstallationFix(issue: SanityIssue): string | undefined {
        if (!issue.fix) return undefined;
        const params = issue.params || {};
        const keys = [
            params.binary ? `backup.installation.fixes.${issue.code}.${params.binary}` : '',
            `backup.installation.fixes.${issue.code}`
        ].filter(Boolean);
        for (const fixKey of keys) {
            const translated = t(fixKey, params);
            if (translated !== fixKey) return translated;
        }
        return issue.fix;
    }

    /** Loads installation / dependency health from the API. */
    async function fetchHealth() {
        try {
            const { data } = await api.get('/backup-api/health');
            installationReport.value = data ?? healthUnavailableReport();
        } catch {
            installationReport.value = healthUnavailableReport();
        }
    }

    /** Builds a fail-closed health report when the health endpoint is unreachable. */
    function healthUnavailableReport(): SanityReport {
        return {
            ok: false,
            operational: false,
            restoreReady: false,
            checkedAt: new Date().toISOString(),
            issues: [{
                code: 'HEALTH_CHECK_FAILED',
                severity: 'error',
                message: 'Could not load the backup installation health report.',
                fix: 'Check that the Directus backup API endpoint is reachable, then reload the module.'
            }]
        };
    }

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
    async function fetchList(options: { silent?: boolean } = {}) {
        try {
            const { data } = await api.get('/backup-api/list');
            backups.value = data ?? [];
        } catch (e: unknown) {
            const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
            if (!options.silent) showNotice(msg || t('backup.notices.load_failed'), 'danger');
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

    return {
        backups,
        loading,
        creating,
        deletingId,
        cancellingId,
        notice,
        noticeType,
        showErrorDialog,
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
        installationReport,
        canBackup,
        canRestore,
        installationErrors,
        installationWarnings,
        formatInstallationIssue,
        activity,
        collections,
        relations,
        config,
        backupRunScope,
        restoreRunScope,
        scheduleMinuteInput,
        scheduleHourInput,
        quotaInput,
        minFreeInput,
        storage,
        storagePercent,
        hasRunning,
        translateError,
        showNotice,
        closeError,
        fetchList,
        fetchConfig,
        fetchStorage,
        fetchActivity,
        fetchCollections,
        fetchRelations,
        fetchHealth
    };
}

/** Aggregate type of the reactive backup state + fetchers + notice helpers. */
export type BackupData = ReturnType<typeof useBackupData>;
