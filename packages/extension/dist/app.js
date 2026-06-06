import { useApi, defineModule } from '@directus/extensions-sdk';
import { ref, computed, watch, reactive, defineComponent, resolveComponent, openBlock, createBlock, withCtx, createVNode, createTextVNode, toDisplayString, normalizeClass, unref, createElementVNode, createElementBlock, Fragment, createCommentVNode, renderList, withModifiers, onMounted, onUnmounted, resolveDirective, isRef, withDirectives, Teleport, normalizeStyle, withKeys } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * UI translation strings (English + German) for the backup module, merged into
 * the Directus i18n instance at runtime.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
const enUS = {
  backup: {
    title: "Backups",
    nav: {
      status: "Status",
      settings: "Settings"
    },
    actions: {
      restore_from_file: "Restore from File",
      uploading: "Uploading\u2026",
      create_backup: "Create Backup",
      download: "Download",
      restore: "Restore",
      delete: "Delete",
      cancel: "Cancel",
      cancel_backup: "Cancel Backup",
      close: "Close",
      create: "Create",
      configure: "Configure\u2026"
    },
    settings: {
      schedule: "Schedule",
      at_minute: "At minute",
      at_hour: "At hour",
      retention: "Retention",
      quota_mb: "Quota (MB)",
      min_free_mb: "Min. free (MB)",
      quota_placeholder: "0 = unlimited",
      label_placeholder: "Optional label (e.g. pre-deploy, vor-migration)",
      backup_scope: "Default Scope",
      tooltips: {
        schedule: "How often automatic backups are created.",
        at_minute: "Within each interval, start the backup at this minute (0\u201359).",
        at_hour: "Within each interval, start the backup at this UTC hour (0\u201323).",
        retention: "How many backups to keep. Older backups are deleted automatically once the limit is reached.",
        quota_mb: "Maximum total storage used by all backup files combined (MB). New backups are blocked when this limit is reached. 0 = no limit.",
        min_free_mb: "Minimum free disk space (MB) required on the volume before a backup starts. Checked independently of the quota \u2014 prevents backups when the disk is nearly full.",
        backup_scope: "Default scope for scheduled backups: which components (database, assets, extensions) and collections are included. Manual backups use individual settings."
      }
    },
    schedule: {
      off: "Off",
      hourly: "Hourly",
      every_6h: "Every 6 hours",
      every_12h: "Every 12 hours",
      daily: "Daily",
      every_3d: "Every 3 days",
      weekly: "Weekly"
    },
    retention: {
      all: "Keep all",
      last_3: "Keep last 3",
      last_5: "Keep last 5",
      last_10: "Keep last 10",
      days_7: "Last 7 days",
      days_30: "Last 30 days"
    },
    table: {
      label: "Label",
      status: "Status",
      size: "Size",
      created: "Created",
      restored: "Restored",
      actions: "Actions"
    },
    storage: {
      used: "Used",
      free: "Free"
    },
    status: {
      success: "success",
      failed: "failed",
      running: "running",
      restore_failed: "(failed)"
    },
    restore_state: {
      restored: "restored",
      skipped: "skipped"
    },
    detail: {
      id: "ID",
      source: "Source",
      created: "Created",
      finished: "Finished",
      duration: "Duration",
      size: "Size",
      directus: "Directus",
      format: "Format",
      tool: "Tool",
      error: "Error",
      restored: "Restored",
      restore_section: "Restore",
      restore_error: "Restore Error",
      restore_components: "Components",
      component_database: "Database",
      component_assets: "Assets",
      component_extensions: "Extensions",
      scope: "Scope",
      included_collections: "Included",
      excluded_collections: "Excluded"
    },
    dialogs: {
      error_title: "Error",
      delete_title: "Delete Backup",
      delete_confirm: "Are you sure you want to delete {id}? This cannot be undone.",
      create_title: "Create Backup",
      restore_title: "Restore {label}",
      restore_warning: "Directus will be stopped during the restore and restarted afterwards. Do not close this tab. The page will reload automatically when done."
    },
    overlay: {
      title: "Restore in progress\u2026",
      hint_restart: "Directus is restarting. Please do not reload the page.",
      hint_reload: "This page will reload automatically when done."
    },
    notices: {
      no_backups: "No backups yet.",
      load_failed: "Failed to load backups",
      config_save_failed: "Failed to save config",
      already_running: "Backup already running.",
      create_failed: "Backup creation failed",
      upload_failed: "Upload failed",
      delete_failed: "Delete failed",
      cancel_failed: "Cancel failed",
      restore_failed: "Restore failed to start"
    },
    errors: {
      QUOTA_EXCEEDED: "Storage limit reached: usage {used} MB >= quota {quota} MB",
      QUOTA_IMPORT_EXCEEDED: "Storage limit reached: usage {used} MB + import {import} MB > quota {quota} MB",
      DISK_FULL: "Not enough free disk space: {free} MB free, minimum {min} MB required",
      ALREADY_RUNNING: "Another backup or restore is already running.",
      IMPORT_DISABLED: "Backup import is disabled by the server configuration.",
      EXPORT_DISABLED: "Backup export is disabled by the server configuration."
    },
    scope: {
      title_backup: "Default Scope",
      title_create: "Backup Scope",
      title_restore: "Restore Scope",
      default_scope_hint: "For manual backups, individual settings apply.",
      database: "Database",
      assets: "Assets",
      extensions: "Extensions",
      include_collections: "Included Collections",
      search_placeholder: "Search collections\u2026",
      no_selections: "No collections selected \u2014 all collections will be included.",
      select_all: "Select all",
      select_none: "Clear",
      dependency_warning_intro: "Deselected collections are still linked to selected ones:",
      dependency_warning_hint_backup: "Consider including them again to keep the backup consistent.",
      dependency_warning_hint_restore: "Consider including them again to avoid breaking references.",
      save: "Save"
    },
    activity: {
      title: "Activity",
      backup_success: "Backup completed",
      backup_failed: "Backup failed",
      backup_cancelled: "Backup cancelled",
      delete: "Backup deleted",
      upload: "Backup imported",
      restore_success: "Restore completed",
      restore_failed: "Restore failed",
      config: "Settings changed",
      error: "Error",
      empty: "No activity yet.",
      source_manual: "Manual",
      source_scheduled: "Scheduled"
    }
  }
};
const deDE = {
  backup: {
    title: "Backups",
    nav: {
      status: "Status",
      settings: "Einstellungen"
    },
    actions: {
      restore_from_file: "Aus Datei wiederherstellen",
      uploading: "Hochladen\u2026",
      create_backup: "Backup erstellen",
      download: "Herunterladen",
      restore: "Wiederherstellen",
      delete: "L\xF6schen",
      cancel: "Abbrechen",
      cancel_backup: "Backup abbrechen",
      close: "Schlie\xDFen",
      create: "Erstellen",
      configure: "Konfigurieren\u2026"
    },
    settings: {
      schedule: "Zeitplan",
      at_minute: "Zur Minute",
      at_hour: "Zur Stunde",
      retention: "Aufbewahrung",
      quota_mb: "Kontingent (MB)",
      min_free_mb: "Min. frei (MB)",
      quota_placeholder: "0 = unbegrenzt",
      label_placeholder: "Optionale Bezeichnung (z.\xA0B. pre-deploy, vor-migration)",
      backup_scope: "Standard-Umfang",
      tooltips: {
        schedule: "Wie h\xE4ufig automatische Backups erstellt werden.",
        at_minute: "Innerhalb des Intervalls: Backup startet zu dieser Minute (0\u201359).",
        at_hour: "Innerhalb des Intervalls: Backup startet zu dieser Stunde (0\u201323, UTC).",
        retention: "Wie viele Backups aufbewahrt werden. \xC4ltere Backups werden automatisch gel\xF6scht, sobald das Limit erreicht ist.",
        quota_mb: "Maximaler Gesamtspeicher aller Backup-Dateien zusammen (MB). Neue Backups werden blockiert, wenn dieses Limit erreicht ist. 0 = unbegrenzt.",
        min_free_mb: "Mindestens verf\xFCgbarer freier Speicherplatz (MB) auf dem Datentr\xE4ger vor einem Backup. Wird unabh\xE4ngig vom Kontingent gepr\xFCft \u2014 verhindert Backups bei nahezu vollem Datentr\xE4ger.",
        backup_scope: "Standard-Umfang f\xFCr geplante Backups: Komponenten (Datenbank, Assets, Erweiterungen) und Collections. F\xFCr manuelle Backups gelten individuelle Einstellungen."
      }
    },
    schedule: {
      off: "Aus",
      hourly: "St\xFCndlich",
      every_6h: "Alle 6 Stunden",
      every_12h: "Alle 12 Stunden",
      daily: "T\xE4glich",
      every_3d: "Alle 3 Tage",
      weekly: "W\xF6chentlich"
    },
    retention: {
      all: "Alle behalten",
      last_3: "Letzte 3 behalten",
      last_5: "Letzte 5 behalten",
      last_10: "Letzte 10 behalten",
      days_7: "Letzte 7 Tage",
      days_30: "Letzte 30 Tage"
    },
    table: {
      label: "Bezeichnung",
      status: "Status",
      size: "Gr\xF6\xDFe",
      created: "Erstellt",
      restored: "Wiederhergestellt",
      actions: "Aktionen"
    },
    storage: {
      used: "Belegt",
      free: "Frei"
    },
    status: {
      success: "Erfolgreich",
      failed: "Fehlgeschlagen",
      running: "L\xE4uft",
      restore_failed: "(fehlgeschlagen)"
    },
    restore_state: {
      restored: "wiederhergestellt",
      skipped: "\xFCbersprungen"
    },
    detail: {
      id: "ID",
      source: "Quelle",
      created: "Erstellt",
      finished: "Abgeschlossen",
      duration: "Dauer",
      size: "Gr\xF6\xDFe",
      directus: "Directus",
      format: "Format",
      tool: "Werkzeug",
      error: "Fehler",
      restored: "Wiederhergestellt",
      restore_section: "Wiederherstellung",
      restore_error: "Wiederherstellungsfehler",
      restore_components: "Komponenten",
      component_database: "Datenbank",
      component_assets: "Assets",
      component_extensions: "Erweiterungen",
      scope: "Umfang",
      included_collections: "Eingeschlossen",
      excluded_collections: "Ausgeschlossen"
    },
    dialogs: {
      error_title: "Fehler",
      delete_title: "Backup l\xF6schen",
      delete_confirm: "Soll {id} wirklich gel\xF6scht werden? Dies kann nicht r\xFCckg\xE4ngig gemacht werden.",
      create_title: "Backup erstellen",
      restore_title: "{label} wiederherstellen",
      restore_warning: "Directus wird w\xE4hrend der Wiederherstellung gestoppt und danach neu gestartet. Schlie\xDFen Sie diesen Tab nicht. Die Seite wird automatisch neu geladen."
    },
    overlay: {
      title: "Wiederherstellung l\xE4uft\u2026",
      hint_restart: "Directus wird neu gestartet. Bitte laden Sie die Seite nicht neu.",
      hint_reload: "Diese Seite wird automatisch neu geladen, sobald der Vorgang abgeschlossen ist."
    },
    notices: {
      no_backups: "Noch keine Backups vorhanden.",
      load_failed: "Backups konnten nicht geladen werden",
      config_save_failed: "Konfiguration konnte nicht gespeichert werden",
      already_running: "Backup l\xE4uft bereits.",
      create_failed: "Backup-Erstellung fehlgeschlagen",
      upload_failed: "Upload fehlgeschlagen",
      delete_failed: "L\xF6schen fehlgeschlagen",
      cancel_failed: "Abbrechen fehlgeschlagen",
      restore_failed: "Wiederherstellung konnte nicht gestartet werden"
    },
    errors: {
      QUOTA_EXCEEDED: "Speicherlimit erreicht: Belegung {used} MB >= Kontingent {quota} MB",
      QUOTA_IMPORT_EXCEEDED: "Speicherlimit erreicht: Belegung {used} MB + Import {import} MB > Kontingent {quota} MB",
      DISK_FULL: "Zu wenig freier Speicherplatz: {free} MB frei, Minimum {min} MB erforderlich",
      ALREADY_RUNNING: "Ein anderes Backup oder eine Wiederherstellung l\xE4uft bereits.",
      IMPORT_DISABLED: "Der Backup-Import ist in der Serverkonfiguration deaktiviert.",
      EXPORT_DISABLED: "Der Backup-Export ist in der Serverkonfiguration deaktiviert."
    },
    scope: {
      title_backup: "Standard-Umfang",
      title_create: "Backup-Umfang",
      title_restore: "Restore-Umfang",
      default_scope_hint: "F\xFCr manuelle Backups gelten individuelle Einstellungen.",
      database: "Datenbank",
      assets: "Assets",
      extensions: "Extensions",
      include_collections: "Eingeschlossene Collections",
      search_placeholder: "Collections suchen\u2026",
      no_selections: "Keine Collections ausgew\xE4hlt \u2014 alle Collections werden eingeschlossen.",
      select_all: "Alle ausw\xE4hlen",
      select_none: "Auswahl l\xF6schen",
      dependency_warning_intro: "Abgew\xE4hlte Collections sind noch verkn\xFCpft mit:",
      dependency_warning_hint_backup: "Erw\xE4gen Sie, sie wieder einzuschlie\xDFen, um ein konsistentes Backup zu gew\xE4hrleisten.",
      dependency_warning_hint_restore: "Erw\xE4gen Sie, sie wieder einzuschlie\xDFen, um Referenzen nicht zu besch\xE4digen.",
      save: "Speichern"
    },
    activity: {
      title: "Aktivit\xE4t",
      backup_success: "Backup abgeschlossen",
      backup_failed: "Backup fehlgeschlagen",
      backup_cancelled: "Backup abgebrochen",
      delete: "Backup gel\xF6scht",
      upload: "Backup importiert",
      restore_success: "Wiederherstellung abgeschlossen",
      restore_failed: "Wiederherstellung fehlgeschlagen",
      config: "Einstellungen ge\xE4ndert",
      error: "Fehler",
      empty: "Noch keine Aktivit\xE4t.",
      source_manual: "Manuell",
      source_scheduled: "Geplant"
    }
  }
};
let merged = false;
function mergeBackupTranslations(i18n) {
  if (merged) return;
  merged = true;
  i18n.mergeLocaleMessage("en-US", enUS);
  i18n.mergeLocaleMessage("de-DE", deDE);
}

/**
 * Display formatters for sizes, dates, and durations used across the module UI.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}
function formatMB(mb) {
  if (mb < 1024) return `${mb} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(1)} GB`;
  return `${(gb / 1024).toFixed(1)} TB`;
}
function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
function formatDuration(start, end) {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "\u2014";
  const s = Math.round(ms / 1e3);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function formatRelativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1e3);
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Backup table composable — sort state, persisted column widths, and the
 * schedule/retention select options for the module UI.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
const WIDTHS_KEY = "backup-table-widths";
const defaultWidths = {
  label: 200,
  status: 140,
  sizeBytes: 100,
  createdAt: 200,
  restoredAt: 200,
  actions: 130
};
function loadWidths() {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
    return raw ? { ...defaultWidths, ...JSON.parse(raw) } : { ...defaultWidths };
  } catch {
    return { ...defaultWidths };
  }
}
function useBackupTable(backups, t) {
  const sortBy = ref("createdAt");
  const sortDesc = ref(true);
  const sortState = computed({
    get: () => ({ by: sortBy.value, desc: sortDesc.value }),
    set: (v) => {
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
      const va = String(a[by] ?? "");
      const vb = String(b[by] ?? "");
      const cmp = va.localeCompare(vb);
      return desc ? -cmp : cmp;
    });
  });
  const columnWidths = ref(loadWidths());
  const headers = computed(() => [
    { text: t("backup.table.label"), value: "label", width: columnWidths.value.label },
    { text: t("backup.table.status"), value: "status", width: columnWidths.value.status },
    { text: t("backup.table.size"), value: "sizeBytes", width: columnWidths.value.sizeBytes },
    { text: t("backup.table.created"), value: "createdAt", width: columnWidths.value.createdAt },
    { text: t("backup.table.restored"), value: "restoredAt", width: columnWidths.value.restoredAt, sortable: false },
    { text: t("backup.table.actions"), value: "actions", width: columnWidths.value.actions, sortable: false }
  ]);
  function onHeadersUpdate(updated) {
    const widths = { ...columnWidths.value };
    for (const h of updated) {
      if (h.width !== void 0 && h.value in widths) widths[h.value] = h.width;
    }
    columnWidths.value = widths;
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
  }
  const scheduleOptions = computed(() => [
    { text: t("backup.schedule.off"), value: "off" },
    { text: t("backup.schedule.hourly"), value: "1h" },
    { text: t("backup.schedule.every_6h"), value: "6h" },
    { text: t("backup.schedule.every_12h"), value: "12h" },
    { text: t("backup.schedule.daily"), value: "daily" },
    { text: t("backup.schedule.every_3d"), value: "3d" },
    { text: t("backup.schedule.weekly"), value: "weekly" }
  ]);
  const retentionOptions = computed(() => [
    { text: t("backup.retention.all"), value: "all" },
    { text: t("backup.retention.last_3"), value: "last-3" },
    { text: t("backup.retention.last_5"), value: "last-5" },
    { text: t("backup.retention.last_10"), value: "last-10" },
    { text: t("backup.retention.days_7"), value: "days-7" },
    { text: t("backup.retention.days_30"), value: "days-30" }
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

/**
 * Backup module API composable — wraps every `/backup-api/*` call and owns the
 * reactive UI state (backups, config, storage, activity) plus polling control.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
function useBackupApi(api, t) {
  const backups = ref([]);
  const loading = ref(true);
  const creating = ref(false);
  const deletingId = ref(null);
  const cancellingId = ref(null);
  const notice = ref("");
  const noticeType = ref("info");
  const showErrorDialog = ref(false);
  const showCreateDialog = ref(false);
  const newLabel = ref("");
  watch(newLabel, (val) => {
    if (val.includes(" ")) newLabel.value = val.replace(/ /g, "-");
  });
  const showDeleteDialog = ref(false);
  const pendingDeleteId = ref("");
  const showRestoreDialog = ref(false);
  const pendingRestoreId = ref("");
  const pendingRestoreManifest = ref(null);
  const restoring = ref(false);
  const uploading = ref(false);
  const configLoading = ref(false);
  const importEnabled = ref(false);
  const exportEnabled = ref(false);
  const activity = ref([]);
  const collections = ref([]);
  const relations = ref([]);
  let pollTimer = null;
  let idleTimer = null;
  const config = reactive({
    schedule: "off",
    scheduleMinute: 0,
    scheduleHour: 0,
    retention: "all",
    quotaMB: 0,
    minFreeMB: 100,
    backupScope: { database: true, assets: true, extensions: false, excludedCollections: [] }
  });
  const backupRunScope = reactive({ database: true, assets: true, extensions: false, includeCollections: [] });
  const restoreRunScope = reactive({ database: true, assets: true, extensions: false, includeCollections: [] });
  const scheduleMinuteInput = ref("0");
  const scheduleHourInput = ref("0");
  const quotaInput = ref("0");
  const minFreeInput = ref("100");
  const storage = ref(null);
  const storagePercent = computed(() => {
    if (!storage.value?.usedMB || config.quotaMB <= 0) return 0;
    return Math.round(storage.value.usedMB / config.quotaMB * 100);
  });
  const hasRunning = computed(() => backups.value.some((b) => b.status === "running"));
  function translateError(data, fallback) {
    if (!data?.code) return data?.error || fallback;
    const key = `backup.errors.${data.code}`;
    const params = {};
    if (data.usedMB !== void 0) params.used = data.usedMB;
    if (data.importMB !== void 0) params.import = data.importMB;
    if (data.quotaMB !== void 0) params.quota = data.quotaMB;
    if (data.freeMB !== void 0) params.free = data.freeMB;
    if (data.minFreeMB !== void 0) params.min = data.minFreeMB;
    const translated = t(key, params);
    return translated === key ? data.error || fallback : translated;
  }
  function showNotice(msg, type = "info") {
    notice.value = msg;
    noticeType.value = type;
    showErrorDialog.value = true;
  }
  function closeError() {
    showErrorDialog.value = false;
    notice.value = "";
  }
  async function fetchList() {
    try {
      const { data } = await api.get("/backup-api/list");
      backups.value = data ?? [];
    } catch (e) {
      const msg = e?.response?.data?.error;
      showNotice(msg || t("backup.notices.load_failed"), "danger");
    } finally {
      loading.value = false;
    }
  }
  async function fetchConfig() {
    try {
      configLoading.value = true;
      const { data } = await api.get("/backup-api/config");
      if (data?.schedule) config.schedule = data.schedule;
      if (data?.scheduleMinute !== void 0) config.scheduleMinute = data.scheduleMinute;
      if (data?.scheduleHour !== void 0) config.scheduleHour = data.scheduleHour;
      if (data?.retention) config.retention = data.retention;
      if (data?.quotaMB !== void 0) config.quotaMB = data.quotaMB;
      if (data?.minFreeMB !== void 0) config.minFreeMB = data.minFreeMB;
      if (data?.importEnabled !== void 0) importEnabled.value = data.importEnabled;
      if (data?.exportEnabled !== void 0) exportEnabled.value = data.exportEnabled;
      if (data?.backupScope) Object.assign(config.backupScope, data.backupScope);
      scheduleMinuteInput.value = String(config.scheduleMinute);
      scheduleHourInput.value = String(config.scheduleHour);
      quotaInput.value = String(config.quotaMB);
      minFreeInput.value = String(config.minFreeMB);
    } catch {
    } finally {
      configLoading.value = false;
    }
  }
  async function saveConfig() {
    try {
      await api.put("/backup-api/config", {
        schedule: config.schedule,
        scheduleMinute: config.scheduleMinute,
        scheduleHour: config.scheduleHour,
        retention: config.retention,
        quotaMB: config.quotaMB,
        minFreeMB: config.minFreeMB,
        backupScope: { ...config.backupScope }
      });
    } catch (e) {
      const msg = e?.response?.data?.error;
      showNotice(msg || t("backup.notices.config_save_failed"), "danger");
      await fetchConfig();
    }
  }
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
  async function fetchStorage() {
    try {
      const { data } = await api.get("/backup-api/storage");
      storage.value = { usedMB: data?.usedMB ?? null, freeMB: data?.freeMB ?? null };
    } catch {
    }
  }
  async function fetchActivity() {
    try {
      const { data } = await api.get("/backup-api/activity?limit=50");
      activity.value = data ?? [];
    } catch {
    }
  }
  async function fetchCollections() {
    try {
      const { data } = await api.get("/collections");
      collections.value = (data?.data ?? data ?? []).map((c) => c.collection).filter((n) => typeof n === "string").sort();
    } catch {
    }
  }
  async function fetchRelations() {
    try {
      const { data } = await api.get("/relations");
      relations.value = (data?.data ?? data ?? []).filter((r) => r.collection && r.related_collection).map((r) => ({
        collection: String(r.collection),
        related_collection: String(r.related_collection)
      }));
    } catch {
    }
  }
  function openCreateDialog() {
    backupRunScope.database = config.backupScope.database;
    backupRunScope.assets = config.backupScope.assets;
    backupRunScope.extensions = config.backupScope.extensions;
    backupRunScope.includeCollections = [...collections.value];
    newLabel.value = "";
    showCreateDialog.value = true;
  }
  function normalizeRunScope(scope, allCollections) {
    const allSelected = allCollections.length > 0 && allCollections.every((c) => scope.includeCollections.includes(c));
    return { ...scope, includeCollections: allSelected ? [] : scope.includeCollections };
  }
  async function createBackup() {
    creating.value = true;
    notice.value = "";
    const label = newLabel.value.trim().replace(/[^a-zA-Z0-9_-]/g, "") || void 0;
    try {
      const scope = normalizeRunScope({ ...backupRunScope }, collections.value);
      await api.post("/backup-api/create", { label, scope });
      showCreateDialog.value = false;
      newLabel.value = "";
      await Promise.all([fetchList(), fetchStorage(), fetchActivity()]);
      startPolling();
    } catch (e) {
      const resp = e?.response;
      if (resp?.status === 409) {
        showNotice(translateError(resp?.data, t("backup.notices.already_running")), "warning");
      } else {
        showNotice(translateError(resp?.data, t("backup.notices.create_failed")), "danger");
      }
    } finally {
      creating.value = false;
    }
  }
  function downloadBackup(id) {
    window.open(`/backup-api/${id}/download`, "_blank");
  }
  async function handleFileSelected(event) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    uploading.value = true;
    notice.value = "";
    try {
      const { data } = await api.post("/backup-api/upload", file, {
        headers: { "Content-Type": "application/gzip" }
      });
      await Promise.all([fetchList(), fetchStorage(), fetchActivity()]);
      if (data?.id) {
        pendingRestoreId.value = data.id;
        pendingRestoreManifest.value = data ?? null;
        initRestoreScope(pendingRestoreManifest.value);
        showRestoreDialog.value = true;
      }
    } catch (e) {
      const resp = e?.response;
      showNotice(translateError(resp?.data, t("backup.notices.upload_failed")), "danger");
    } finally {
      uploading.value = false;
    }
  }
  function initRestoreScope(manifest) {
    const scope = manifest?.scope;
    restoreRunScope.database = scope?.database !== false;
    restoreRunScope.assets = scope?.assets !== false;
    restoreRunScope.extensions = scope?.extensions !== false;
    const allCollections = scope?.collections ? [...scope.collections] : [];
    restoreRunScope.includeCollections = collections.value.length > 0 ? allCollections.filter((c) => collections.value.includes(c)) : allCollections;
  }
  function restoreBackup(id) {
    pendingRestoreId.value = id;
    pendingRestoreManifest.value = backups.value.find((b) => b.id === id) ?? null;
    initRestoreScope(pendingRestoreManifest.value);
    showRestoreDialog.value = true;
  }
  async function confirmRestore() {
    const id = pendingRestoreId.value;
    showRestoreDialog.value = false;
    restoring.value = true;
    try {
      const manifestCollections = pendingRestoreManifest.value?.scope?.collections ?? [];
      const availableCollections = collections.value.length > 0 ? manifestCollections.filter((c) => collections.value.includes(c)) : manifestCollections;
      const scope = normalizeRunScope({ ...restoreRunScope }, availableCollections);
      await api.post(`/backup-api/${id}/restore`, { scope });
    } catch (e) {
      const msg = e?.response?.data?.error;
      showNotice(msg || t("backup.notices.restore_failed"), "danger");
      restoring.value = false;
      return;
    }
    const poll = async () => {
      await new Promise((r) => {
        setTimeout(r, 3e3);
      });
      try {
        await api.get("/backup-api/list");
        try {
          await api.post("/auth/logout");
        } catch {
        }
        window.location.href = "/admin/login";
      } catch (e) {
        const status = e?.response?.status;
        if (status === 401 || status === 403) {
          window.location.href = "/admin/login";
        } else {
          poll();
        }
      }
    };
    poll();
  }
  function deleteBackup(id) {
    pendingDeleteId.value = id;
    showDeleteDialog.value = true;
  }
  async function confirmDelete() {
    const id = pendingDeleteId.value;
    showDeleteDialog.value = false;
    deletingId.value = id;
    try {
      await api.delete(`/backup-api/${id}`);
      await Promise.all([fetchList(), fetchStorage(), fetchActivity()]);
    } catch (e) {
      const msg = e?.response?.data?.error;
      showNotice(msg || t("backup.notices.delete_failed"), "danger");
    } finally {
      deletingId.value = null;
    }
  }
  async function cancelBackup(id) {
    cancellingId.value = id;
    try {
      await api.post(`/backup-api/${id}/cancel`);
      await Promise.all([fetchList(), fetchActivity()]);
    } catch (e) {
      const msg = e?.response?.data?.error;
      showNotice(msg || t("backup.notices.cancel_failed"), "danger");
    } finally {
      cancellingId.value = null;
    }
  }
  function startPolling() {
    if (pollTimer) return;
    stopIdlePolling();
    pollTimer = setInterval(async () => {
      const wasRunning = hasRunning.value;
      await Promise.all([fetchList(), fetchActivity()]);
      if (!hasRunning.value) {
        stopPolling();
        if (wasRunning) await fetchStorage();
        startIdlePolling();
      }
    }, 5e3);
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  function startIdlePolling() {
    if (idleTimer) return;
    idleTimer = setInterval(async () => {
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
    }, 3e4);
  }
  function stopIdlePolling() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }
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

const _hoisted_1$4 = { class: "detail-grid" };
const _hoisted_2$3 = { class: "detail-mono" };
const _hoisted_3$3 = { class: "detail-error detail-error-block" };
const _hoisted_4$3 = { class: "detail-mono" };
const _hoisted_5$3 = { class: "detail-mono" };
const _hoisted_6$3 = { class: "detail-section-divider" };
const _hoisted_7$3 = { class: "detail-section-label" };
const _hoisted_8$3 = { class: "detail-grid" };
const _hoisted_9$3 = { class: "detail-error detail-error-block" };
var _sfc_main$4 = /* @__PURE__ */ defineComponent({
  __name: "BackupDetailDialog",
  props: {
    modelValue: { type: Boolean },
    item: {}
  },
  emits: ["update:modelValue"],
  setup(__props) {
    const props = __props;
    const { t } = useI18n();
    const scopeSummary = computed(() => {
      const s = props.item?.scope;
      if (!s) return "";
      const parts = [];
      if (s.database) parts.push(t("backup.scope.database"));
      if (s.assets) parts.push(t("backup.scope.assets"));
      if (s.extensions) parts.push(t("backup.scope.extensions"));
      return parts.length > 0 ? parts.join(" + ") : "\u2014";
    });
    const restoreStatusLabel = computed(() => {
      const s = props.item?.restoreStatus;
      if (s === "failed") return t("backup.status.restore_failed");
      return t("backup.status.success");
    });
    return (_ctx, _cache) => {
      const _component_v_icon = resolveComponent("v-icon");
      const _component_v_chip = resolveComponent("v-chip");
      const _component_v_card_title = resolveComponent("v-card-title");
      const _component_v_card_text = resolveComponent("v-card-text");
      const _component_v_button = resolveComponent("v-button");
      const _component_v_card_actions = resolveComponent("v-card-actions");
      const _component_v_card = resolveComponent("v-card");
      const _component_v_dialog = resolveComponent("v-dialog");
      return openBlock(), createBlock(_component_v_dialog, {
        "model-value": __props.modelValue,
        "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => _ctx.$emit("update:modelValue", $event)),
        onEsc: _cache[2] || (_cache[2] = ($event) => _ctx.$emit("update:modelValue", false))
      }, {
        default: withCtx(() => [
          __props.item ? (openBlock(), createBlock(_component_v_card, {
            key: 0,
            class: "detail-card"
          }, {
            default: withCtx(() => [
              createVNode(_component_v_card_title, { class: "detail-title" }, {
                default: withCtx(() => [
                  createVNode(_component_v_icon, {
                    name: __props.item.source === "scheduled" ? "schedule" : "person"
                  }, null, 8, ["name"]),
                  createTextVNode(
                    " " + toDisplayString(__props.item.label) + " ",
                    1
                    /* TEXT */
                  ),
                  createVNode(_component_v_chip, {
                    class: normalizeClass(["status-chip", `status-${__props.item.status}`]),
                    small: ""
                  }, {
                    default: withCtx(() => [
                      createTextVNode(
                        toDisplayString(unref(t)("backup.status." + __props.item.status)),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  }, 8, ["class"])
                ]),
                _: 1
                /* STABLE */
              }),
              createVNode(_component_v_card_text, null, {
                default: withCtx(() => [
                  createElementVNode("dl", _hoisted_1$4, [
                    createElementVNode(
                      "dt",
                      null,
                      toDisplayString(unref(t)("backup.detail.id")),
                      1
                      /* TEXT */
                    ),
                    createElementVNode(
                      "dd",
                      _hoisted_2$3,
                      toDisplayString(__props.item.id),
                      1
                      /* TEXT */
                    ),
                    createElementVNode(
                      "dt",
                      null,
                      toDisplayString(unref(t)("backup.detail.source")),
                      1
                      /* TEXT */
                    ),
                    createElementVNode(
                      "dd",
                      null,
                      toDisplayString(__props.item.source === "scheduled" ? unref(t)("backup.activity.source_scheduled") : unref(t)("backup.activity.source_manual")),
                      1
                      /* TEXT */
                    ),
                    createElementVNode(
                      "dt",
                      null,
                      toDisplayString(unref(t)("backup.detail.created")),
                      1
                      /* TEXT */
                    ),
                    createElementVNode(
                      "dd",
                      null,
                      toDisplayString(unref(formatDate)(__props.item.createdAt)),
                      1
                      /* TEXT */
                    ),
                    __props.item.finishedAt ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 0 },
                      [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.finished")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          null,
                          toDisplayString(unref(formatDate)(__props.item.finishedAt)),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.duration")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          null,
                          toDisplayString(unref(formatDuration)(__props.item.createdAt, __props.item.finishedAt)),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true),
                    __props.item.sizeBytes ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 1 },
                      [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.size")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          null,
                          toDisplayString(unref(formatSize)(__props.item.sizeBytes)),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true),
                    __props.item.directusVersion ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 2 },
                      [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.directus")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          null,
                          "v" + toDisplayString(__props.item.directusVersion),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true),
                    __props.item.dumpFormat ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 3 },
                      [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.format")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          null,
                          toDisplayString(__props.item.dumpFormat),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true),
                    __props.item.tool ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 4 },
                      [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.tool")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          null,
                          toDisplayString(__props.item.tool.name) + toDisplayString(__props.item.tool.version ? ` ${__props.item.tool.version}` : ""),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true),
                    __props.item.error ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 5 },
                      [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.error")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          _hoisted_3$3,
                          toDisplayString(__props.item.error),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true),
                    __props.item.scope ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 6 },
                      [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.scope")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          null,
                          toDisplayString(scopeSummary.value),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true),
                    __props.item.scope?.includedCollections?.length ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 7 },
                      [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.included_collections")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          _hoisted_4$3,
                          toDisplayString(__props.item.scope.includedCollections.join(", ")),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true),
                    __props.item.scope?.excludedCollections?.length ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 8 },
                      [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.excluded_collections")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          _hoisted_5$3,
                          toDisplayString(__props.item.scope.excludedCollections.join(", ")),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true)
                  ]),
                  __props.item.restoredAt ? (openBlock(), createElementBlock(
                    Fragment,
                    { key: 0 },
                    [
                      createElementVNode("div", _hoisted_6$3, [
                        createElementVNode(
                          "span",
                          _hoisted_7$3,
                          toDisplayString(unref(t)("backup.detail.restore_section")),
                          1
                          /* TEXT */
                        ),
                        __props.item.restoreStatus ? (openBlock(), createBlock(_component_v_chip, {
                          key: 0,
                          class: normalizeClass(["status-chip", `status-${__props.item.restoreStatus}`]),
                          small: ""
                        }, {
                          default: withCtx(() => [
                            createTextVNode(
                              toDisplayString(restoreStatusLabel.value),
                              1
                              /* TEXT */
                            )
                          ]),
                          _: 1
                          /* STABLE */
                        }, 8, ["class"])) : createCommentVNode("v-if", true)
                      ]),
                      createElementVNode("dl", _hoisted_8$3, [
                        createElementVNode(
                          "dt",
                          null,
                          toDisplayString(unref(t)("backup.detail.restored")),
                          1
                          /* TEXT */
                        ),
                        createElementVNode(
                          "dd",
                          null,
                          toDisplayString(unref(formatDate)(__props.item.restoredAt)),
                          1
                          /* TEXT */
                        ),
                        __props.item.restore ? (openBlock(), createElementBlock(
                          Fragment,
                          { key: 0 },
                          [
                            createElementVNode(
                              "dt",
                              null,
                              toDisplayString(unref(t)("backup.detail.restore_components")),
                              1
                              /* TEXT */
                            ),
                            createElementVNode("dd", null, [
                              (openBlock(true), createElementBlock(
                                Fragment,
                                null,
                                renderList(__props.item.restore, (state, comp) => {
                                  return openBlock(), createElementBlock(
                                    "div",
                                    { key: comp },
                                    toDisplayString(unref(t)("backup.detail.component_" + comp)) + ": " + toDisplayString(unref(t)("backup.restore_state." + state)),
                                    1
                                    /* TEXT */
                                  );
                                }),
                                128
                                /* KEYED_FRAGMENT */
                              ))
                            ])
                          ],
                          64
                          /* STABLE_FRAGMENT */
                        )) : createCommentVNode("v-if", true),
                        __props.item.restoreError ? (openBlock(), createElementBlock(
                          Fragment,
                          { key: 1 },
                          [
                            createElementVNode(
                              "dt",
                              null,
                              toDisplayString(unref(t)("backup.detail.restore_error")),
                              1
                              /* TEXT */
                            ),
                            createElementVNode(
                              "dd",
                              _hoisted_9$3,
                              toDisplayString(__props.item.restoreError),
                              1
                              /* TEXT */
                            )
                          ],
                          64
                          /* STABLE_FRAGMENT */
                        )) : createCommentVNode("v-if", true)
                      ])
                    ],
                    64
                    /* STABLE_FRAGMENT */
                  )) : createCommentVNode("v-if", true)
                ]),
                _: 1
                /* STABLE */
              }),
              createVNode(_component_v_card_actions, null, {
                default: withCtx(() => [
                  createVNode(_component_v_button, {
                    secondary: "",
                    onClick: _cache[0] || (_cache[0] = ($event) => _ctx.$emit("update:modelValue", false))
                  }, {
                    default: withCtx(() => [
                      createTextVNode(
                        toDisplayString(unref(t)("backup.actions.close")),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  })
                ]),
                _: 1
                /* STABLE */
              })
            ]),
            _: 1
            /* STABLE */
          })) : createCommentVNode("v-if", true)
        ]),
        _: 1
        /* STABLE */
      }, 8, ["model-value"]);
    };
  }
});

var e=[],t=[];function n(n,r){if(n&&"undefined"!=typeof document){var a,s=true===r.prepend?"prepend":"append",d=true===r.singleTag,i="string"==typeof r.container?document.querySelector(r.container):document.getElementsByTagName("head")[0];if(d){var u=e.indexOf(i);-1===u&&(u=e.push(i)-1,t[u]={}),a=t[u]&&t[u][s]?t[u][s]:t[u][s]=c();}else a=c();65279===n.charCodeAt(0)&&(n=n.substring(1)),a.styleSheet?a.styleSheet.cssText+=n:a.appendChild(document.createTextNode(n));}function c(){var e=document.createElement("style");if(e.setAttribute("type","text/css"),r.attributes)for(var t=Object.keys(r.attributes),n=0;n<t.length;n++)e.setAttribute(t[n],r.attributes[t[n]]);var a="prepend"===s?"afterbegin":"beforeend";return i.insertAdjacentElement(a,e),e}}

var css$4 = "\n[data-v-eb077f83] .v-card-title {\n    margin-bottom: var(--content-padding);\n    padding-bottom: var(--content-padding);\n    padding-block-start: 0.438rem;\n    border-bottom: 0.063rem solid var(--theme--border-color, var(--border-normal));\n    font-size: 1.25rem;\n}\n.detail-card[data-v-eb077f83] {\n    min-width: 30rem;\n}\n.detail-title[data-v-eb077f83] {\n    display: flex;\n    align-items: center;\n    gap: 0.5rem;\n}\n.detail-title .status-chip[data-v-eb077f83] {\n    margin-left: auto;\n}\n.detail-grid[data-v-eb077f83] {\n    display: grid;\n    grid-template-columns: max-content 1fr;\n    align-items: start;\n    gap: 0.375rem 1rem;\n}\n.detail-grid dt[data-v-eb077f83] {\n    min-width: 9.063rem;\n    padding-top: 0.063rem;\n    font-weight: 600;\n    color: var(--theme--foreground-subdued);\n    white-space: nowrap;\n}\n.detail-grid dd[data-v-eb077f83] {\n    margin: 0;\n    color: var(--theme--foreground);\n    word-break: break-word;\n}\n.detail-mono[data-v-eb077f83] {\n    font-family: var(--theme--fonts--monospace--font-family, monospace);\n    font-size: 0.75rem;\n}\n.detail-error[data-v-eb077f83] {\n    color: var(--danger);\n}\n.detail-error-block[data-v-eb077f83] {\n    max-height: 12.5rem;\n    padding: 0.5rem 0.625rem;\n    border-radius: var(--theme--border-radius, 0.375rem);\n    background: var(--danger-10, rgba(var(--danger-rgb), 0.1));\n    font-family: var(--theme--fonts--monospace--font-family, monospace);\n    white-space: pre-wrap;\n    overflow-y: auto;\n}\n.detail-section-divider[data-v-eb077f83] {\n    display: flex;\n    align-items: center;\n    gap: 0.5rem;\n    margin: 1rem 0 0.5rem;\n    padding-top: 0.75rem;\n    border-top: 0.063rem solid var(--theme--border-color, var(--border-normal));\n}\n.detail-section-label[data-v-eb077f83] {\n    font-size: 0.875rem;\n    font-weight: 600;\n    color: var(--theme--foreground);\n}\n.detail-section-divider .status-chip[data-v-eb077f83] {\n    margin-left: auto;\n}\n.status-chip[data-v-eb077f83] {\n    font-size: 0.75rem;\n    font-weight: 600;\n    text-transform: uppercase;\n}\n.status-success[data-v-eb077f83] {\n    --v-chip-color: var(--success);\n    --v-chip-background-color: var(--success-10);\n}\n.status-failed[data-v-eb077f83] {\n    --v-chip-color: var(--danger);\n    --v-chip-background-color: var(--danger-10);\n}\n.status-running[data-v-eb077f83] {\n    --v-chip-color: var(--warning);\n    --v-chip-background-color: var(--warning-10);\n}\n";
n(css$4,{});

var _export_sfc = (sfc, props) => {
  const target = sfc.__vccOpts || sfc;
  for (const [key, val] of props) {
    target[key] = val;
  }
  return target;
};

var BackupDetailDialog = /* @__PURE__ */ _export_sfc(_sfc_main$4, [["__scopeId", "data-v-eb077f83"]]);

const _hoisted_1$3 = { class: "scope-fields" };
const _hoisted_2$2 = { class: "scope-section" };
const _hoisted_3$2 = {
  key: 0,
  class: "scope-toggle"
};
const _hoisted_4$2 = {
  key: 1,
  class: "scope-toggle"
};
const _hoisted_5$2 = {
  key: 2,
  class: "scope-toggle"
};
const _hoisted_6$2 = {
  key: 0,
  class: "scope-section"
};
const _hoisted_7$2 = { class: "scope-section-label" };
const _hoisted_8$2 = {
  key: 0,
  class: "collection-select-all"
};
const _hoisted_9$2 = { class: "collection-list" };
const _hoisted_10$1 = { class: "collection-name" };
const _hoisted_11$1 = {
  key: 0,
  class: "scope-empty"
};
const _hoisted_12$1 = { class: "dependency-intro" };
const _hoisted_13$1 = { class: "dependency-list" };
const _hoisted_14$1 = { class: "dependency-name" };
const _hoisted_15$1 = { class: "dependency-linked" };
const _hoisted_16$1 = { class: "dependency-hint" };
var _sfc_main$3 = /* @__PURE__ */ defineComponent({
  __name: "ScopeFields",
  props: {
    scope: {},
    collections: {},
    relations: { default: () => [] },
    availableComponents: { default: () => ["database", "assets", "extensions"] },
    mode: { default: "backup" }
  },
  emits: ["update"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit = __emit;
    const { t } = useI18n();
    const search = ref("");
    function showComponent(component) {
      return props.availableComponents.includes(component);
    }
    const filteredCollections = computed(() => {
      const q = (search.value ?? "").toLowerCase();
      return props.collections.filter((c) => !q || c.toLowerCase().includes(q));
    });
    function toggleCollection(col, checked) {
      const next = checked ? [...props.scope.includeCollections, col] : props.scope.includeCollections.filter((c) => c !== col);
      emit("update", { includeCollections: next });
    }
    function selectAll() {
      const toAdd = search.value ? filteredCollections.value : props.collections;
      const current = new Set(props.scope.includeCollections);
      toAdd.forEach((c) => current.add(c));
      emit("update", { includeCollections: [...current] });
    }
    function selectNone() {
      const filtered = new Set(filteredCollections.value);
      emit("update", { includeCollections: props.scope.includeCollections.filter((c) => !filtered.has(c)) });
    }
    const dependencyIssues = computed(() => {
      if (props.scope.includeCollections.length === 0) return [];
      const included = new Set(props.scope.includeCollections);
      const known = new Set(props.collections);
      const groups = /* @__PURE__ */ new Map();
      for (const rel of props.relations) {
        if (!known.has(rel.collection) || !known.has(rel.related_collection)) continue;
        if (included.has(rel.collection) && !included.has(rel.related_collection)) {
          const linked = groups.get(rel.related_collection) ?? /* @__PURE__ */ new Set();
          linked.add(rel.collection);
          groups.set(rel.related_collection, linked);
        }
        if (included.has(rel.related_collection) && !included.has(rel.collection)) {
          const linked = groups.get(rel.collection) ?? /* @__PURE__ */ new Set();
          linked.add(rel.related_collection);
          groups.set(rel.collection, linked);
        }
      }
      return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([deselected, linkedSet]) => ({
        deselected,
        linked: [...linkedSet].sort()
      }));
    });
    const dependencyIntro = computed(() => t("backup.scope.dependency_warning_intro"));
    const dependencyHint = computed(() => t(
      props.mode === "restore" ? "backup.scope.dependency_warning_hint_restore" : "backup.scope.dependency_warning_hint_backup"
    ));
    return (_ctx, _cache) => {
      const _component_v_checkbox = resolveComponent("v-checkbox");
      const _component_v_icon = resolveComponent("v-icon");
      const _component_v_input = resolveComponent("v-input");
      const _component_v_notice = resolveComponent("v-notice");
      return openBlock(), createElementBlock("div", _hoisted_1$3, [
        createElementVNode("div", _hoisted_2$2, [
          showComponent("database") ? (openBlock(), createElementBlock("label", _hoisted_3$2, [
            createVNode(_component_v_checkbox, {
              "model-value": __props.scope.database,
              "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => _ctx.$emit("update", { database: $event }))
            }, null, 8, ["model-value"]),
            createElementVNode(
              "span",
              null,
              toDisplayString(unref(t)("backup.scope.database")),
              1
              /* TEXT */
            )
          ])) : createCommentVNode("v-if", true),
          showComponent("assets") ? (openBlock(), createElementBlock("label", _hoisted_4$2, [
            createVNode(_component_v_checkbox, {
              "model-value": __props.scope.assets,
              "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => _ctx.$emit("update", { assets: $event }))
            }, null, 8, ["model-value"]),
            createElementVNode(
              "span",
              null,
              toDisplayString(unref(t)("backup.scope.assets")),
              1
              /* TEXT */
            )
          ])) : createCommentVNode("v-if", true),
          showComponent("extensions") ? (openBlock(), createElementBlock("label", _hoisted_5$2, [
            createVNode(_component_v_checkbox, {
              "model-value": __props.scope.extensions,
              "onUpdate:modelValue": _cache[2] || (_cache[2] = ($event) => _ctx.$emit("update", { extensions: $event }))
            }, null, 8, ["model-value"]),
            createElementVNode(
              "span",
              null,
              toDisplayString(unref(t)("backup.scope.extensions")),
              1
              /* TEXT */
            )
          ])) : createCommentVNode("v-if", true)
        ]),
        __props.scope.database && showComponent("database") && __props.collections.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_6$2, [
          createElementVNode(
            "div",
            _hoisted_7$2,
            toDisplayString(unref(t)("backup.scope.include_collections")),
            1
            /* TEXT */
          ),
          createVNode(_component_v_input, {
            modelValue: search.value,
            "onUpdate:modelValue": _cache[3] || (_cache[3] = ($event) => search.value = $event),
            placeholder: unref(t)("backup.scope.search_placeholder"),
            class: "scope-search",
            onKeydown: _cache[4] || (_cache[4] = withModifiers(() => {
            }, ["stop"]))
          }, {
            prepend: withCtx(() => [
              createVNode(_component_v_icon, { name: "search" })
            ]),
            _: 1
            /* STABLE */
          }, 8, ["modelValue", "placeholder"]),
          filteredCollections.value.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_8$2, [
            createElementVNode(
              "button",
              {
                class: "select-all-btn",
                onClick: selectAll
              },
              toDisplayString(unref(t)("backup.scope.select_all")),
              1
              /* TEXT */
            ),
            _cache[5] || (_cache[5] = createElementVNode(
              "span",
              { class: "select-all-sep" },
              "\xB7",
              -1
              /* CACHED */
            )),
            createElementVNode(
              "button",
              {
                class: "select-all-btn",
                onClick: selectNone
              },
              toDisplayString(unref(t)("backup.scope.select_none")),
              1
              /* TEXT */
            )
          ])) : createCommentVNode("v-if", true),
          createElementVNode("div", _hoisted_9$2, [
            (openBlock(true), createElementBlock(
              Fragment,
              null,
              renderList(filteredCollections.value, (col) => {
                return openBlock(), createElementBlock("label", {
                  key: col,
                  class: "collection-item"
                }, [
                  createVNode(_component_v_checkbox, {
                    "model-value": __props.scope.includeCollections.includes(col),
                    "onUpdate:modelValue": ($event) => toggleCollection(col, $event)
                  }, null, 8, ["model-value", "onUpdate:modelValue"]),
                  createElementVNode(
                    "span",
                    _hoisted_10$1,
                    toDisplayString(col),
                    1
                    /* TEXT */
                  )
                ]);
              }),
              128
              /* KEYED_FRAGMENT */
            )),
            filteredCollections.value.length === 0 ? (openBlock(), createElementBlock(
              "p",
              _hoisted_11$1,
              toDisplayString(search.value ? "\u2014" : unref(t)("backup.scope.no_selections")),
              1
              /* TEXT */
            )) : createCommentVNode("v-if", true)
          ]),
          dependencyIssues.value.length > 0 ? (openBlock(), createBlock(_component_v_notice, {
            key: 1,
            type: "warning",
            class: "scope-warning"
          }, {
            default: withCtx(() => [
              createElementVNode(
                "p",
                _hoisted_12$1,
                toDisplayString(dependencyIntro.value),
                1
                /* TEXT */
              ),
              createElementVNode("ul", _hoisted_13$1, [
                (openBlock(true), createElementBlock(
                  Fragment,
                  null,
                  renderList(dependencyIssues.value, (item) => {
                    return openBlock(), createElementBlock("li", {
                      key: item.deselected
                    }, [
                      createElementVNode(
                        "span",
                        _hoisted_14$1,
                        toDisplayString(item.deselected),
                        1
                        /* TEXT */
                      ),
                      _cache[6] || (_cache[6] = createElementVNode(
                        "span",
                        { class: "dependency-arrow" },
                        "\u2192",
                        -1
                        /* CACHED */
                      )),
                      createElementVNode(
                        "span",
                        _hoisted_15$1,
                        toDisplayString(item.linked.join(", ")),
                        1
                        /* TEXT */
                      )
                    ]);
                  }),
                  128
                  /* KEYED_FRAGMENT */
                ))
              ]),
              createElementVNode(
                "p",
                _hoisted_16$1,
                toDisplayString(dependencyHint.value),
                1
                /* TEXT */
              )
            ]),
            _: 1
            /* STABLE */
          })) : createCommentVNode("v-if", true)
        ])) : createCommentVNode("v-if", true)
      ]);
    };
  }
});

var css$3 = "\n.scope-section[data-v-f3d3fb9e] {\n    margin-bottom: 1rem;\n}\n.scope-section[data-v-f3d3fb9e]:last-child {\n    margin-bottom: 0;\n}\n.scope-section-label[data-v-f3d3fb9e] {\n    margin-bottom: 0.5rem;\n    font-size: 0.875rem;\n    font-weight: 600;\n    color: var(--theme--foreground);\n}\n.scope-toggle[data-v-f3d3fb9e] {\n    display: flex;\n    align-items: center;\n    gap: 0.5rem;\n    padding: 0.25rem 0;\n    cursor: pointer;\n}\n.scope-search[data-v-f3d3fb9e] {\n    margin-bottom: 0.5rem;\n}\n.collection-select-all[data-v-f3d3fb9e] {\n    display: flex;\n    align-items: center;\n    gap: 0.375rem;\n    margin-bottom: 0.375rem;\n    font-size: 0.813rem;\n    color: var(--theme--foreground-subdued);\n}\n.select-all-btn[data-v-f3d3fb9e] {\n    padding: 0;\n    border: none;\n    background: none;\n    font-size: 0.813rem;\n    color: var(--theme--primary);\n    cursor: pointer;\n}\n.select-all-btn[data-v-f3d3fb9e]:hover {\n    text-decoration: underline;\n}\n.select-all-sep[data-v-f3d3fb9e] {\n    color: var(--theme--border-color);\n}\n.collection-list[data-v-f3d3fb9e] {\n    max-height: 17.5rem;\n    padding: 0.25rem 0;\n    border: 0.063rem solid var(--theme--border-color-subdued);\n    border-radius: var(--theme--border-radius);\n    overflow-y: auto;\n}\n.collection-item[data-v-f3d3fb9e] {\n    display: flex;\n    align-items: center;\n    gap: 0.5rem;\n    padding: 0.25rem 0.75rem;\n    cursor: pointer;\n}\n.collection-item[data-v-f3d3fb9e]:hover {\n    background: var(--theme--background-accent);\n}\n.collection-name[data-v-f3d3fb9e] {\n    font-family: var(--theme--fonts--monospace--font-family, monospace);\n    font-size: 0.813rem;\n}\n.scope-empty[data-v-f3d3fb9e] {\n    padding: 0.75rem;\n    font-size: 0.813rem;\n    color: var(--theme--foreground-subdued);\n    text-align: center;\n}\n.scope-warning[data-v-f3d3fb9e] {\n    box-sizing: border-box;\n    width: 100%;\n    margin-top: 0.75rem;\n    word-break: break-word;\n    overflow-wrap: break-word;\n}\n.scope-warning[data-v-f3d3fb9e] * {\n    white-space: normal;\n    word-break: break-word;\n    overflow-wrap: break-word;\n}\n.dependency-intro[data-v-f3d3fb9e],\n.dependency-hint[data-v-f3d3fb9e] {\n    margin: 0;\n    font-size: 0.813rem;\n    line-height: 1.4;\n}\n.dependency-hint[data-v-f3d3fb9e] {\n    margin-top: 0.5rem;\n}\n.dependency-list[data-v-f3d3fb9e] {\n    margin: 0.375rem 0 0;\n    padding-left: 1.125rem;\n    font-size: 0.813rem;\n    line-height: 1.5;\n}\n.dependency-list li[data-v-f3d3fb9e] {\n    margin: 0.125rem 0;\n}\n.dependency-name[data-v-f3d3fb9e],\n.dependency-linked[data-v-f3d3fb9e] {\n    font-family: var(--theme--fonts--monospace--font-family, monospace);\n}\n.dependency-arrow[data-v-f3d3fb9e] {\n    margin: 0 0.25rem;\n    color: var(--theme--foreground-subdued);\n}\n";
n(css$3,{});

var ScopeFields = /* @__PURE__ */ _export_sfc(_sfc_main$3, [["__scopeId", "data-v-f3d3fb9e"]]);

const _hoisted_1$2 = {
  key: 0,
  class: "scope-hint"
};
var _sfc_main$2 = /* @__PURE__ */ defineComponent({
  __name: "ScopeDialog",
  props: {
    modelValue: { type: Boolean },
    title: {},
    hint: {},
    scope: {},
    collections: {},
    relations: {}
  },
  emits: ["update:modelValue", "save"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit = __emit;
    const { t } = useI18n();
    const local = reactive({
      database: true,
      assets: true,
      extensions: false,
      includeCollections: []
    });
    const scopeEmpty = computed(() => !local.database && !local.assets && !local.extensions || local.database && local.includeCollections.length === 0 && props.collections.length > 0);
    watch(() => props.modelValue, (open) => {
      if (open) {
        local.database = props.scope.database;
        local.assets = props.scope.assets;
        local.extensions = props.scope.extensions;
        local.includeCollections = props.scope.includeCollections.length > 0 ? [...props.scope.includeCollections] : [...props.collections];
      }
    });
    function onUpdate(patch) {
      Object.assign(local, patch);
    }
    function save() {
      const allSelected = props.collections.length > 0 && props.collections.every((c) => local.includeCollections.includes(c));
      emit("save", {
        database: local.database,
        assets: local.assets,
        extensions: local.extensions,
        includeCollections: allSelected ? [] : [...local.includeCollections]
      });
      emit("update:modelValue", false);
    }
    return (_ctx, _cache) => {
      const _component_v_card_title = resolveComponent("v-card-title");
      const _component_v_card_text = resolveComponent("v-card-text");
      const _component_v_button = resolveComponent("v-button");
      const _component_v_card_actions = resolveComponent("v-card-actions");
      const _component_v_card = resolveComponent("v-card");
      const _component_v_dialog = resolveComponent("v-dialog");
      return openBlock(), createBlock(_component_v_dialog, {
        "model-value": __props.modelValue,
        "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => _ctx.$emit("update:modelValue", $event)),
        onEsc: _cache[2] || (_cache[2] = ($event) => _ctx.$emit("update:modelValue", false))
      }, {
        default: withCtx(() => [
          createVNode(_component_v_card, { class: "scope-card" }, {
            default: withCtx(() => [
              createVNode(_component_v_card_title, null, {
                default: withCtx(() => [
                  createTextVNode(
                    toDisplayString(__props.title),
                    1
                    /* TEXT */
                  )
                ]),
                _: 1
                /* STABLE */
              }),
              createVNode(_component_v_card_text, null, {
                default: withCtx(() => [
                  __props.hint ? (openBlock(), createElementBlock(
                    "p",
                    _hoisted_1$2,
                    toDisplayString(__props.hint),
                    1
                    /* TEXT */
                  )) : createCommentVNode("v-if", true),
                  createVNode(ScopeFields, {
                    mode: "backup",
                    scope: local,
                    collections: __props.collections,
                    relations: __props.relations,
                    onUpdate
                  }, null, 8, ["scope", "collections", "relations"])
                ]),
                _: 1
                /* STABLE */
              }),
              createVNode(_component_v_card_actions, null, {
                default: withCtx(() => [
                  createVNode(_component_v_button, {
                    secondary: "",
                    onClick: _cache[0] || (_cache[0] = ($event) => _ctx.$emit("update:modelValue", false))
                  }, {
                    default: withCtx(() => [
                      createTextVNode(
                        toDisplayString(unref(t)("backup.actions.cancel")),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  }),
                  createVNode(_component_v_button, {
                    disabled: scopeEmpty.value,
                    onClick: save
                  }, {
                    default: withCtx(() => [
                      createTextVNode(
                        toDisplayString(unref(t)("backup.scope.save")),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  }, 8, ["disabled"])
                ]),
                _: 1
                /* STABLE */
              })
            ]),
            _: 1
            /* STABLE */
          })
        ]),
        _: 1
        /* STABLE */
      }, 8, ["model-value"]);
    };
  }
});

var css$2 = "\n[data-v-bcd464ce] .v-card-title {\n    margin-bottom: var(--content-padding);\n    padding-bottom: var(--content-padding);\n    padding-block-start: 0.438rem;\n    border-bottom: 0.063rem solid var(--theme--border-color, var(--border-normal));\n    font-size: 1.25rem;\n}\n.scope-card[data-v-bcd464ce] {\n    width: 33.75rem;\n    min-width: 26.25rem;\n    max-width: 33.75rem;\n}\n.scope-hint[data-v-bcd464ce] {\n    margin-bottom: var(--content-padding);\n    font-size: 0.875rem;\n    color: var(--theme--foreground-subdued, var(--foreground-subdued));\n}\n";
n(css$2,{});

var ScopeDialog = /* @__PURE__ */ _export_sfc(_sfc_main$2, [["__scopeId", "data-v-bcd464ce"]]);

const _hoisted_1$1 = {
  key: 0,
  class: "activity-empty"
};
const _hoisted_2$1 = {
  key: 1,
  class: "activity-list"
};
const _hoisted_3$1 = { class: "activity-body" };
const _hoisted_4$1 = { class: "activity-header" };
const _hoisted_5$1 = { class: "activity-action" };
const _hoisted_6$1 = { class: "activity-time" };
const _hoisted_7$1 = {
  key: 0,
  class: "activity-meta"
};
const _hoisted_8$1 = { class: "activity-id" };
const _hoisted_9$1 = {
  key: 1,
  class: "activity-detail"
};
var _sfc_main$1 = /* @__PURE__ */ defineComponent({
  __name: "ActivitySidebar",
  props: {
    activity: {}
  },
  setup(__props) {
    const { t } = useI18n();
    function activityIcon(action) {
      const map = {
        backup_success: "check_circle",
        backup_failed: "error",
        delete: "delete",
        upload: "upload_file",
        restore_success: "settings_backup_restore",
        restore_failed: "error",
        config: "settings",
        error: "error"
      };
      return map[action] ?? "info";
    }
    function activityIconClass(action) {
      if (action.endsWith("_failed") || action === "error") return "activity-icon-danger";
      if (action === "delete") return "activity-icon-warning";
      if (action.endsWith("_success") || action === "upload") return "activity-icon-success";
      return "";
    }
    function activityLabel(action) {
      const key = `backup.activity.${action}`;
      const val = t(key);
      return val === key ? action : val;
    }
    return (_ctx, _cache) => {
      const _component_v_icon = resolveComponent("v-icon");
      return __props.activity.length === 0 ? (openBlock(), createElementBlock(
        "div",
        _hoisted_1$1,
        toDisplayString(unref(t)("backup.activity.empty")),
        1
        /* TEXT */
      )) : (openBlock(), createElementBlock("div", _hoisted_2$1, [
        (openBlock(true), createElementBlock(
          Fragment,
          null,
          renderList(__props.activity, (entry, idx) => {
            return openBlock(), createElementBlock("div", {
              key: idx,
              class: "activity-item"
            }, [
              createVNode(_component_v_icon, {
                name: activityIcon(entry.action),
                class: normalizeClass(["activity-icon", activityIconClass(entry.action)])
              }, null, 8, ["name", "class"]),
              createElementVNode("div", _hoisted_3$1, [
                createElementVNode("div", _hoisted_4$1, [
                  createElementVNode(
                    "span",
                    _hoisted_5$1,
                    toDisplayString(activityLabel(entry.action)),
                    1
                    /* TEXT */
                  ),
                  createElementVNode(
                    "span",
                    _hoisted_6$1,
                    toDisplayString(unref(formatRelativeTime)(entry.timestamp)),
                    1
                    /* TEXT */
                  )
                ]),
                entry.backupId ? (openBlock(), createElementBlock("div", _hoisted_7$1, [
                  createElementVNode(
                    "span",
                    _hoisted_8$1,
                    toDisplayString(entry.backupId),
                    1
                    /* TEXT */
                  )
                ])) : createCommentVNode("v-if", true),
                entry.detail ? (openBlock(), createElementBlock(
                  "span",
                  _hoisted_9$1,
                  toDisplayString(entry.detail),
                  1
                  /* TEXT */
                )) : createCommentVNode("v-if", true)
              ])
            ]);
          }),
          128
          /* KEYED_FRAGMENT */
        ))
      ]));
    };
  }
});

var css$1 = "\n.activity-list[data-v-9bf1a215] {\n    display: flex;\n    flex-direction: column;\n}\n.activity-item[data-v-9bf1a215] {\n    display: flex;\n    align-items: flex-start;\n    gap: 0.5rem;\n    padding: 0.5rem 0;\n    border-bottom: 0.063rem solid var(--theme--border-color-subdued);\n}\n.activity-item[data-v-9bf1a215]:last-child {\n    border-bottom: none;\n}\n.activity-header[data-v-9bf1a215] {\n    display: flex;\n    justify-content: space-between;\n    align-items: baseline;\n    gap: 0.5rem;\n}\n.activity-body[data-v-9bf1a215] {\n    display: flex;\n    flex-direction: column;\n    gap: 0.125rem;\n    min-width: 0;\n    flex: 1;\n}\n.activity-action[data-v-9bf1a215] {\n    font-size: 0.875rem;\n    font-weight: 600;\n    color: var(--theme--foreground);\n}\n.activity-time[data-v-9bf1a215] {\n    font-size: 0.813rem;\n    color: var(--theme--foreground-subdued);\n    white-space: nowrap;\n}\n.activity-icon[data-v-9bf1a215] {\n    --v-icon-color: var(--theme--foreground-subdued);\n    --v-icon-size: 1.5rem;\n\n    flex-shrink: 0;\n    margin-top: 0.063rem;\n}\n.activity-icon-success[data-v-9bf1a215] {\n    --v-icon-color: var(--success);\n}\n.activity-icon-warning[data-v-9bf1a215] {\n    --v-icon-color: var(--warning);\n}\n.activity-icon-danger[data-v-9bf1a215] {\n    --v-icon-color: var(--danger);\n}\n.activity-meta[data-v-9bf1a215] {\n    display: flex;\n    align-items: center;\n    gap: 0.375rem;\n    min-width: 0;\n}\n.activity-id[data-v-9bf1a215] {\n    overflow: hidden;\n    font-family: var(--theme--fonts--monospace--font-family, monospace);\n    font-size: 0.75rem;\n    color: var(--theme--foreground-subdued);\n    white-space: nowrap;\n    text-overflow: ellipsis;\n}\n.activity-detail[data-v-9bf1a215] {\n    font-size: 0.75rem;\n    color: var(--theme--foreground-subdued);\n}\n.activity-empty[data-v-9bf1a215] {\n    padding: 0.75rem;\n    font-size: 0.813rem;\n    font-style: italic;\n    color: var(--theme--foreground-subdued);\n}\n";
n(css$1,{});

var ActivitySidebar = /* @__PURE__ */ _export_sfc(_sfc_main$1, [["__scopeId", "data-v-9bf1a215"]]);

const _hoisted_1 = { class: "icon" };
const _hoisted_2 = { class: "nav-content" };
const _hoisted_3 = { class: "nav-section" };
const _hoisted_4 = { class: "nav-section-title" };
const _hoisted_5 = {
  key: 0,
  class: "nav-storage"
};
const _hoisted_6 = { class: "nav-storage-row" };
const _hoisted_7 = { class: "nav-storage-label" };
const _hoisted_8 = { class: "nav-storage-row" };
const _hoisted_9 = { class: "nav-storage-label" };
const _hoisted_10 = {
  key: 0,
  class: "storage-bar-track"
};
const _hoisted_11 = { class: "nav-section" };
const _hoisted_12 = { class: "nav-section-title" };
const _hoisted_13 = { class: "nav-field" };
const _hoisted_14 = { class: "nav-field-label" };
const _hoisted_15 = {
  key: 0,
  class: "nav-field"
};
const _hoisted_16 = { class: "nav-field-label" };
const _hoisted_17 = {
  key: 1,
  class: "nav-field"
};
const _hoisted_18 = { class: "nav-field-label" };
const _hoisted_19 = { class: "nav-field" };
const _hoisted_20 = { class: "nav-field-label" };
const _hoisted_21 = { class: "nav-field" };
const _hoisted_22 = { class: "nav-field-label" };
const _hoisted_23 = { class: "nav-field" };
const _hoisted_24 = { class: "nav-field-label" };
const _hoisted_25 = { class: "nav-scope-buttons" };
const _hoisted_26 = { class: "nav-field-label" };
const _hoisted_27 = { class: "backup-content" };
const _hoisted_28 = {
  key: 0,
  class: "center"
};
const _hoisted_29 = { class: "label-cell" };
const _hoisted_30 = {
  key: 0,
  class: "restored-error-hint"
};
const _hoisted_31 = {
  key: 1,
  class: "restored-empty"
};
const _hoisted_32 = { class: "create-scope" };
const _hoisted_33 = { class: "create-scope-label" };
const _hoisted_34 = { class: "create-scope" };
const _hoisted_35 = { class: "create-scope-label" };
const _hoisted_36 = {
  key: 0,
  class: "restore-overlay"
};
const _hoisted_37 = { class: "restore-overlay-box" };
const _hoisted_38 = { class: "restore-title" };
const _hoisted_39 = { class: "restore-hint" };
var _sfc_main = /* @__PURE__ */ defineComponent({
  __name: "BackupModule",
  setup(__props) {
    const i18n = useI18n();
    const { t } = i18n;
    mergeBackupTranslations(i18n);
    const api = useApi();
    const uploadFileInput = ref(null);
    const showDetailDialog = ref(false);
    const detailItem = ref(null);
    const showBackupScope = ref(false);
    const {
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
    } = useBackupApi(api, t);
    const backupScopeForDialog = computed(() => ({
      database: config.backupScope.database,
      assets: config.backupScope.assets,
      extensions: config.backupScope.extensions,
      // Derive inclusions from exclusions; new/unknown collections default to included.
      includeCollections: config.backupScope.excludedCollections.length > 0 ? collections.value.filter((c) => !config.backupScope.excludedCollections.includes(c)) : [...collections.value]
    }));
    const restoreCollections = computed(() => {
      const manifestCollections = pendingRestoreManifest.value?.scope?.collections ?? [];
      if (collections.value.length === 0) return manifestCollections;
      return manifestCollections.filter((c) => collections.value.includes(c));
    });
    const restoreComponents = computed(() => {
      const scope = pendingRestoreManifest.value?.scope;
      const out = [];
      if (scope?.database !== false) out.push("database");
      if (scope?.assets !== false) out.push("assets");
      if (scope?.extensions !== false) out.push("extensions");
      return out;
    });
    const {
      sortState,
      sortedBackups,
      headers,
      onHeadersUpdate,
      scheduleOptions,
      retentionOptions
    } = useBackupTable(backups, t);
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
      if (p <= 50) return "hsl(120, 65%, 45%)";
      const ratio = (p - 50) / 50;
      const hue = Math.round(120 * (1 - ratio));
      return `hsl(${hue}, 65%, 50%)`;
    });
    function triggerUpload() {
      uploadFileInput.value?.click();
    }
    function onRowClick({ item }) {
      detailItem.value = item;
      showDetailDialog.value = true;
    }
    function onSaveBackupScope(scope) {
      config.backupScope.database = scope.database;
      config.backupScope.assets = scope.assets;
      config.backupScope.extensions = scope.extensions;
      config.backupScope.excludedCollections = scope.includeCollections.length === 0 ? [] : collections.value.filter((c) => !scope.includeCollections.includes(c));
      saveConfig();
    }
    function updateBackupRunScope(patch) {
      Object.assign(backupRunScope, patch);
    }
    function updateRestoreRunScope(patch) {
      Object.assign(restoreRunScope, patch);
    }
    onMounted(init);
    onUnmounted(() => {
      stopPolling();
      stopIdlePolling();
    });
    return (_ctx, _cache) => {
      const _component_v_icon = resolveComponent("v-icon");
      const _component_v_button = resolveComponent("v-button");
      const _component_v_select = resolveComponent("v-select");
      const _component_v_input = resolveComponent("v-input");
      const _component_v_progress_circular = resolveComponent("v-progress-circular");
      const _component_v_chip = resolveComponent("v-chip");
      const _component_v_table = resolveComponent("v-table");
      const _component_v_notice = resolveComponent("v-notice");
      const _component_v_card_title = resolveComponent("v-card-title");
      const _component_v_card_text = resolveComponent("v-card-text");
      const _component_v_card_actions = resolveComponent("v-card-actions");
      const _component_v_card = resolveComponent("v-card");
      const _component_v_dialog = resolveComponent("v-dialog");
      const _component_sidebar_detail = resolveComponent("sidebar-detail");
      const _component_private_view = resolveComponent("private-view");
      const _directive_tooltip = resolveDirective("tooltip");
      return openBlock(), createBlock(_component_private_view, {
        title: unref(t)("backup.title")
      }, {
        "title-outer:prepend": withCtx(() => [
          createElementVNode("div", _hoisted_1, [
            createVNode(_component_v_icon, {
              name: "backup",
              small: ""
            })
          ])
        ]),
        actions: withCtx(() => [
          unref(importEnabled) ? withDirectives((openBlock(), createBlock(_component_v_button, {
            key: 0,
            icon: "",
            rounded: "",
            secondary: "",
            small: "",
            disabled: unref(hasRunning) || unref(uploading),
            loading: unref(uploading),
            onClick: triggerUpload
          }, {
            default: withCtx(() => [
              createVNode(_component_v_icon, {
                name: "upload_file",
                small: ""
              })
            ]),
            _: 1
            /* STABLE */
          }, 8, ["disabled", "loading"])), [
            [
              _directive_tooltip,
              unref(t)("backup.actions.restore_from_file"),
              void 0,
              { bottom: true }
            ]
          ]) : createCommentVNode("v-if", true),
          withDirectives((openBlock(), createBlock(_component_v_button, {
            icon: "",
            rounded: "",
            small: "",
            loading: unref(creating),
            disabled: unref(hasRunning),
            onClick: unref(openCreateDialog)
          }, {
            default: withCtx(() => [
              createVNode(_component_v_icon, {
                name: "add",
                small: ""
              })
            ]),
            _: 1
            /* STABLE */
          }, 8, ["loading", "disabled", "onClick"])), [
            [
              _directive_tooltip,
              unref(t)("backup.actions.create_backup"),
              void 0,
              { bottom: true }
            ]
          ])
        ]),
        navigation: withCtx(() => [
          createElementVNode("div", _hoisted_2, [
            createElementVNode("div", _hoisted_3, [
              createElementVNode("div", _hoisted_4, [
                createVNode(_component_v_icon, {
                  name: "monitoring",
                  class: "nav-section-icon"
                }),
                createTextVNode(
                  toDisplayString(unref(t)("backup.nav.status")),
                  1
                  /* TEXT */
                )
              ]),
              unref(storage) ? (openBlock(), createElementBlock("div", _hoisted_5, [
                createElementVNode("div", _hoisted_6, [
                  createElementVNode(
                    "span",
                    _hoisted_7,
                    toDisplayString(unref(t)("backup.storage.used")),
                    1
                    /* TEXT */
                  ),
                  createElementVNode("span", null, [
                    createTextVNode(
                      toDisplayString(unref(storage).usedMB != null ? unref(formatMB)(unref(storage).usedMB) : "?"),
                      1
                      /* TEXT */
                    ),
                    unref(config).quotaMB > 0 ? (openBlock(), createElementBlock(
                      Fragment,
                      { key: 0 },
                      [
                        createTextVNode(
                          " / " + toDisplayString(unref(formatMB)(unref(config).quotaMB)),
                          1
                          /* TEXT */
                        )
                      ],
                      64
                      /* STABLE_FRAGMENT */
                    )) : createCommentVNode("v-if", true)
                  ])
                ]),
                createElementVNode("div", _hoisted_8, [
                  createElementVNode(
                    "span",
                    _hoisted_9,
                    toDisplayString(unref(t)("backup.storage.free")),
                    1
                    /* TEXT */
                  ),
                  createElementVNode(
                    "span",
                    {
                      class: normalizeClass({ "storage-warn": unref(storage).freeMB !== null && unref(config).minFreeMB > 0 && unref(storage).freeMB < unref(config).minFreeMB })
                    },
                    toDisplayString(unref(storage).freeMB != null ? unref(formatMB)(unref(storage).freeMB) : "?"),
                    3
                    /* TEXT, CLASS */
                  )
                ]),
                unref(config).quotaMB > 0 ? (openBlock(), createElementBlock("div", _hoisted_10, [
                  createElementVNode(
                    "div",
                    {
                      class: "storage-bar-fill",
                      style: normalizeStyle({ width: Math.min(unref(storagePercent), 100) + "%", background: storageBarColor.value })
                    },
                    null,
                    4
                    /* STYLE */
                  )
                ])) : createCommentVNode("v-if", true)
              ])) : createCommentVNode("v-if", true)
            ]),
            createElementVNode("div", _hoisted_11, [
              createElementVNode("div", _hoisted_12, [
                createVNode(_component_v_icon, {
                  name: "settings",
                  class: "nav-section-icon"
                }),
                createTextVNode(
                  toDisplayString(unref(t)("backup.nav.settings")),
                  1
                  /* TEXT */
                )
              ]),
              createElementVNode("div", _hoisted_13, [
                createElementVNode("span", _hoisted_14, [
                  createTextVNode(
                    toDisplayString(unref(t)("backup.settings.schedule")) + " ",
                    1
                    /* TEXT */
                  ),
                  withDirectives(createVNode(
                    _component_v_icon,
                    {
                      name: "help",
                      filled: "",
                      class: "nav-field-help"
                    },
                    null,
                    512
                    /* NEED_PATCH */
                  ), [
                    [
                      _directive_tooltip,
                      unref(t)("backup.settings.tooltips.schedule"),
                      void 0,
                      { right: true }
                    ]
                  ])
                ]),
                createVNode(_component_v_select, {
                  modelValue: unref(config).schedule,
                  "onUpdate:modelValue": [
                    _cache[0] || (_cache[0] = ($event) => unref(config).schedule = $event),
                    unref(saveConfig)
                  ],
                  items: unref(scheduleOptions),
                  disabled: unref(configLoading)
                }, null, 8, ["modelValue", "items", "disabled", "onUpdate:modelValue"])
              ]),
              ["1h", "6h", "12h"].includes(unref(config).schedule) ? (openBlock(), createElementBlock("div", _hoisted_15, [
                createElementVNode("span", _hoisted_16, [
                  createTextVNode(
                    toDisplayString(unref(t)("backup.settings.at_minute")) + " ",
                    1
                    /* TEXT */
                  ),
                  withDirectives(createVNode(
                    _component_v_icon,
                    {
                      name: "help",
                      filled: "",
                      class: "nav-field-help"
                    },
                    null,
                    512
                    /* NEED_PATCH */
                  ), [
                    [
                      _directive_tooltip,
                      unref(t)("backup.settings.tooltips.at_minute"),
                      void 0,
                      { right: true }
                    ]
                  ])
                ]),
                createVNode(_component_v_input, {
                  modelValue: unref(scheduleMinuteInput),
                  "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => isRef(scheduleMinuteInput) ? scheduleMinuteInput.value = $event : null),
                  type: "number",
                  min: 0,
                  max: 59,
                  placeholder: "0",
                  disabled: unref(configLoading),
                  onBlur: unref(saveScheduleOffset),
                  onKeyup: _cache[2] || (_cache[2] = withKeys(($event) => $event.target?.blur(), ["enter"]))
                }, null, 8, ["modelValue", "disabled", "onBlur"])
              ])) : createCommentVNode("v-if", true),
              ["daily", "3d", "weekly"].includes(unref(config).schedule) ? (openBlock(), createElementBlock("div", _hoisted_17, [
                createElementVNode("span", _hoisted_18, [
                  createTextVNode(
                    toDisplayString(unref(t)("backup.settings.at_hour")),
                    1
                    /* TEXT */
                  ),
                  withDirectives(createVNode(
                    _component_v_icon,
                    {
                      name: "help",
                      filled: "",
                      class: "nav-field-help"
                    },
                    null,
                    512
                    /* NEED_PATCH */
                  ), [
                    [
                      _directive_tooltip,
                      unref(t)("backup.settings.tooltips.at_hour"),
                      void 0,
                      { right: true }
                    ]
                  ])
                ]),
                createVNode(_component_v_input, {
                  modelValue: unref(scheduleHourInput),
                  "onUpdate:modelValue": _cache[3] || (_cache[3] = ($event) => isRef(scheduleHourInput) ? scheduleHourInput.value = $event : null),
                  type: "number",
                  min: 0,
                  max: 23,
                  placeholder: "0",
                  disabled: unref(configLoading),
                  onBlur: unref(saveScheduleOffset),
                  onKeyup: _cache[4] || (_cache[4] = withKeys(($event) => $event.target?.blur(), ["enter"]))
                }, null, 8, ["modelValue", "disabled", "onBlur"])
              ])) : createCommentVNode("v-if", true),
              createElementVNode("div", _hoisted_19, [
                createElementVNode("span", _hoisted_20, [
                  createTextVNode(
                    toDisplayString(unref(t)("backup.settings.retention")) + " ",
                    1
                    /* TEXT */
                  ),
                  withDirectives(createVNode(
                    _component_v_icon,
                    {
                      name: "help",
                      filled: "",
                      class: "nav-field-help"
                    },
                    null,
                    512
                    /* NEED_PATCH */
                  ), [
                    [
                      _directive_tooltip,
                      unref(t)("backup.settings.tooltips.retention"),
                      void 0,
                      { right: true }
                    ]
                  ])
                ]),
                createVNode(_component_v_select, {
                  modelValue: unref(config).retention,
                  "onUpdate:modelValue": [
                    _cache[5] || (_cache[5] = ($event) => unref(config).retention = $event),
                    unref(saveConfig)
                  ],
                  items: unref(retentionOptions),
                  disabled: unref(configLoading)
                }, null, 8, ["modelValue", "items", "disabled", "onUpdate:modelValue"])
              ]),
              createElementVNode("div", _hoisted_21, [
                createElementVNode("span", _hoisted_22, [
                  createTextVNode(
                    toDisplayString(unref(t)("backup.settings.quota_mb")) + " ",
                    1
                    /* TEXT */
                  ),
                  withDirectives(createVNode(
                    _component_v_icon,
                    {
                      name: "help",
                      filled: "",
                      class: "nav-field-help"
                    },
                    null,
                    512
                    /* NEED_PATCH */
                  ), [
                    [
                      _directive_tooltip,
                      unref(t)("backup.settings.tooltips.quota_mb"),
                      void 0,
                      { right: true }
                    ]
                  ])
                ]),
                createVNode(_component_v_input, {
                  modelValue: unref(quotaInput),
                  "onUpdate:modelValue": _cache[6] || (_cache[6] = ($event) => isRef(quotaInput) ? quotaInput.value = $event : null),
                  type: "number",
                  min: 0,
                  placeholder: unref(t)("backup.settings.quota_placeholder"),
                  disabled: unref(configLoading),
                  onBlur: unref(saveQuotaFields),
                  onKeyup: _cache[7] || (_cache[7] = withKeys(($event) => $event.target?.blur(), ["enter"]))
                }, null, 8, ["modelValue", "placeholder", "disabled", "onBlur"])
              ]),
              createElementVNode("div", _hoisted_23, [
                createElementVNode("span", _hoisted_24, [
                  createTextVNode(
                    toDisplayString(unref(t)("backup.settings.min_free_mb")) + " ",
                    1
                    /* TEXT */
                  ),
                  withDirectives(createVNode(
                    _component_v_icon,
                    {
                      name: "help",
                      filled: "",
                      class: "nav-field-help"
                    },
                    null,
                    512
                    /* NEED_PATCH */
                  ), [
                    [
                      _directive_tooltip,
                      unref(t)("backup.settings.tooltips.min_free_mb"),
                      void 0,
                      { right: true }
                    ]
                  ])
                ]),
                createVNode(_component_v_input, {
                  modelValue: unref(minFreeInput),
                  "onUpdate:modelValue": _cache[8] || (_cache[8] = ($event) => isRef(minFreeInput) ? minFreeInput.value = $event : null),
                  type: "number",
                  min: 0,
                  placeholder: "100",
                  disabled: unref(configLoading),
                  onBlur: unref(saveQuotaFields),
                  onKeyup: _cache[9] || (_cache[9] = withKeys(($event) => $event.target?.blur(), ["enter"]))
                }, null, 8, ["modelValue", "disabled", "onBlur"])
              ])
            ]),
            createElementVNode("div", _hoisted_25, [
              createElementVNode("span", _hoisted_26, [
                createTextVNode(
                  toDisplayString(unref(t)("backup.settings.backup_scope")) + " ",
                  1
                  /* TEXT */
                ),
                withDirectives(createVNode(
                  _component_v_icon,
                  {
                    name: "help",
                    filled: "",
                    class: "nav-field-help"
                  },
                  null,
                  512
                  /* NEED_PATCH */
                ), [
                  [
                    _directive_tooltip,
                    unref(t)("backup.settings.tooltips.backup_scope"),
                    void 0,
                    { right: true }
                  ]
                ])
              ]),
              createVNode(_component_v_button, {
                secondary: "",
                "full-width": "",
                onClick: _cache[10] || (_cache[10] = ($event) => showBackupScope.value = true)
              }, {
                default: withCtx(() => [
                  createTextVNode(
                    toDisplayString(unref(t)("backup.actions.configure")),
                    1
                    /* TEXT */
                  )
                ]),
                _: 1
                /* STABLE */
              })
            ])
          ])
        ]),
        sidebar: withCtx(() => [
          createVNode(_component_sidebar_detail, {
            id: "activity",
            title: unref(t)("backup.activity.title"),
            icon: "history"
          }, {
            default: withCtx(() => [
              createVNode(ActivitySidebar, { activity: unref(activity) }, null, 8, ["activity"])
            ]),
            _: 1
            /* STABLE */
          }, 8, ["title"])
        ]),
        default: withCtx(() => [
          createElementVNode("div", _hoisted_27, [
            unref(loading) && unref(backups).length === 0 ? (openBlock(), createElementBlock("div", _hoisted_28, [
              createVNode(_component_v_progress_circular, { indeterminate: "" })
            ])) : unref(backups).length > 0 ? (openBlock(), createBlock(_component_v_table, {
              key: 1,
              headers: unref(headers),
              items: unref(sortedBackups),
              "item-key": "id",
              loading: unref(loading),
              sort: unref(sortState),
              "onUpdate:sort": _cache[13] || (_cache[13] = ($event) => isRef(sortState) ? sortState.value = $event : null),
              "must-sort": "",
              "show-resize": "",
              "onUpdate:headers": unref(onHeadersUpdate),
              "onClick:row": onRowClick
            }, {
              "item.label": withCtx(({ item }) => [
                createElementVNode("span", _hoisted_29, [
                  createVNode(_component_v_icon, {
                    name: item.source === "scheduled" ? "schedule" : "person",
                    class: "source-icon"
                  }, null, 8, ["name"]),
                  createTextVNode(
                    " " + toDisplayString(item.label),
                    1
                    /* TEXT */
                  )
                ])
              ]),
              "item.status": withCtx(({ item }) => [
                createVNode(_component_v_chip, {
                  class: normalizeClass(["status-chip", `status-${item.status}`]),
                  small: ""
                }, {
                  default: withCtx(() => [
                    createTextVNode(
                      toDisplayString(unref(t)("backup.status." + item.status)),
                      1
                      /* TEXT */
                    )
                  ]),
                  _: 2
                  /* DYNAMIC */
                }, 1032, ["class"])
              ]),
              "item.restoredAt": withCtx(({ item }) => [
                item.restoredAt ? (openBlock(), createElementBlock(
                  "span",
                  {
                    key: 0,
                    class: normalizeClass(["restored-cell", { "restored-failed": item.restoreStatus === "failed" }])
                  },
                  [
                    createTextVNode(
                      toDisplayString(unref(formatDate)(item.restoredAt)) + " ",
                      1
                      /* TEXT */
                    ),
                    item.restoreStatus === "failed" ? (openBlock(), createElementBlock(
                      "span",
                      _hoisted_30,
                      toDisplayString(unref(t)("backup.status.restore_failed")),
                      1
                      /* TEXT */
                    )) : createCommentVNode("v-if", true)
                  ],
                  2
                  /* CLASS */
                )) : (openBlock(), createElementBlock("span", _hoisted_31, "\u2014"))
              ]),
              "item.sizeBytes": withCtx(({ item }) => [
                createTextVNode(
                  toDisplayString(item.sizeBytes ? unref(formatSize)(item.sizeBytes) : "\u2014"),
                  1
                  /* TEXT */
                )
              ]),
              "item.createdAt": withCtx(({ item }) => [
                createTextVNode(
                  toDisplayString(unref(formatDate)(item.createdAt)),
                  1
                  /* TEXT */
                )
              ]),
              "item.actions": withCtx(({ item }) => [
                item.status === "running" ? (openBlock(), createElementBlock("div", {
                  key: 0,
                  class: "action-buttons",
                  onClick: _cache[11] || (_cache[11] = withModifiers(() => {
                  }, ["stop"]))
                }, [
                  withDirectives((openBlock(), createBlock(_component_v_button, {
                    icon: "",
                    rounded: "",
                    secondary: "",
                    small: "",
                    loading: unref(cancellingId) === item.id,
                    disabled: unref(cancellingId) === item.id,
                    onClick: ($event) => unref(cancelBackup)(item.id)
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_v_icon, { name: "close" })
                    ]),
                    _: 1
                    /* STABLE */
                  }, 8, ["loading", "disabled", "onClick"])), [
                    [_directive_tooltip, unref(t)("backup.actions.cancel_backup")]
                  ])
                ])) : (openBlock(), createElementBlock("div", {
                  key: 1,
                  class: "action-buttons",
                  onClick: _cache[12] || (_cache[12] = withModifiers(() => {
                  }, ["stop"]))
                }, [
                  unref(exportEnabled) ? withDirectives((openBlock(), createBlock(_component_v_button, {
                    key: 0,
                    icon: "",
                    rounded: "",
                    secondary: "",
                    small: "",
                    onClick: ($event) => unref(downloadBackup)(item.id)
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_v_icon, { name: "download" })
                    ]),
                    _: 1
                    /* STABLE */
                  }, 8, ["onClick"])), [
                    [_directive_tooltip, unref(t)("backup.actions.download")]
                  ]) : createCommentVNode("v-if", true),
                  item.status === "success" ? withDirectives((openBlock(), createBlock(_component_v_button, {
                    key: 1,
                    icon: "",
                    rounded: "",
                    secondary: "",
                    small: "",
                    onClick: ($event) => unref(restoreBackup)(item.id)
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_v_icon, { name: "settings_backup_restore" })
                    ]),
                    _: 1
                    /* STABLE */
                  }, 8, ["onClick"])), [
                    [_directive_tooltip, unref(t)("backup.actions.restore")]
                  ]) : createCommentVNode("v-if", true),
                  withDirectives((openBlock(), createBlock(_component_v_button, {
                    icon: "",
                    rounded: "",
                    secondary: "",
                    small: "",
                    disabled: unref(deletingId) === item.id,
                    loading: unref(deletingId) === item.id,
                    onClick: ($event) => unref(deleteBackup)(item.id)
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_v_icon, { name: "delete" })
                    ]),
                    _: 1
                    /* STABLE */
                  }, 8, ["disabled", "loading", "onClick"])), [
                    [_directive_tooltip, unref(t)("backup.actions.delete")]
                  ])
                ]))
              ]),
              _: 1
              /* STABLE */
            }, 8, ["headers", "items", "loading", "sort", "onUpdate:headers"])) : (openBlock(), createBlock(_component_v_notice, {
              key: 2,
              type: "info"
            }, {
              default: withCtx(() => [
                createTextVNode(
                  toDisplayString(unref(t)("backup.notices.no_backups")),
                  1
                  /* TEXT */
                )
              ]),
              _: 1
              /* STABLE */
            }))
          ]),
          createVNode(_component_v_dialog, {
            modelValue: unref(showDeleteDialog),
            "onUpdate:modelValue": _cache[15] || (_cache[15] = ($event) => isRef(showDeleteDialog) ? showDeleteDialog.value = $event : null),
            onEsc: _cache[16] || (_cache[16] = ($event) => showDeleteDialog.value = false)
          }, {
            default: withCtx(() => [
              createVNode(_component_v_card, null, {
                default: withCtx(() => [
                  createVNode(_component_v_card_title, null, {
                    default: withCtx(() => [
                      createTextVNode(
                        toDisplayString(unref(t)("backup.dialogs.delete_title")),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  }),
                  createVNode(_component_v_card_text, null, {
                    default: withCtx(() => [
                      createTextVNode(
                        toDisplayString(unref(t)("backup.dialogs.delete_confirm", { id: unref(pendingDeleteId) })),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  }),
                  createVNode(_component_v_card_actions, null, {
                    default: withCtx(() => [
                      createVNode(_component_v_button, {
                        secondary: "",
                        onClick: _cache[14] || (_cache[14] = ($event) => showDeleteDialog.value = false)
                      }, {
                        default: withCtx(() => [
                          createTextVNode(
                            toDisplayString(unref(t)("backup.actions.cancel")),
                            1
                            /* TEXT */
                          )
                        ]),
                        _: 1
                        /* STABLE */
                      }),
                      createVNode(_component_v_button, {
                        kind: "danger",
                        loading: unref(deletingId) === unref(pendingDeleteId),
                        onClick: unref(confirmDelete)
                      }, {
                        default: withCtx(() => [
                          createTextVNode(
                            toDisplayString(unref(t)("backup.actions.delete")),
                            1
                            /* TEXT */
                          )
                        ]),
                        _: 1
                        /* STABLE */
                      }, 8, ["loading", "onClick"])
                    ]),
                    _: 1
                    /* STABLE */
                  })
                ]),
                _: 1
                /* STABLE */
              })
            ]),
            _: 1
            /* STABLE */
          }, 8, ["modelValue"]),
          createVNode(_component_v_dialog, {
            modelValue: unref(showCreateDialog),
            "onUpdate:modelValue": _cache[19] || (_cache[19] = ($event) => isRef(showCreateDialog) ? showCreateDialog.value = $event : null),
            onEsc: _cache[20] || (_cache[20] = ($event) => showCreateDialog.value = false)
          }, {
            default: withCtx(() => [
              createVNode(_component_v_card, null, {
                default: withCtx(() => [
                  createVNode(_component_v_card_title, null, {
                    default: withCtx(() => [
                      createTextVNode(
                        toDisplayString(unref(t)("backup.dialogs.create_title")),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  }),
                  createVNode(_component_v_card_text, null, {
                    default: withCtx(() => [
                      createVNode(_component_v_input, {
                        modelValue: unref(newLabel),
                        "onUpdate:modelValue": _cache[17] || (_cache[17] = ($event) => isRef(newLabel) ? newLabel.value = $event : null),
                        placeholder: unref(t)("backup.settings.label_placeholder"),
                        maxlength: 32
                      }, null, 8, ["modelValue", "placeholder"]),
                      createElementVNode("div", _hoisted_32, [
                        createElementVNode(
                          "div",
                          _hoisted_33,
                          toDisplayString(unref(t)("backup.scope.title_create")),
                          1
                          /* TEXT */
                        ),
                        createVNode(ScopeFields, {
                          mode: "backup",
                          scope: unref(backupRunScope),
                          collections: unref(collections),
                          relations: unref(relations),
                          onUpdate: updateBackupRunScope
                        }, null, 8, ["scope", "collections", "relations"])
                      ])
                    ]),
                    _: 1
                    /* STABLE */
                  }),
                  createVNode(_component_v_card_actions, null, {
                    default: withCtx(() => [
                      createVNode(_component_v_button, {
                        secondary: "",
                        onClick: _cache[18] || (_cache[18] = ($event) => showCreateDialog.value = false)
                      }, {
                        default: withCtx(() => [
                          createTextVNode(
                            toDisplayString(unref(t)("backup.actions.cancel")),
                            1
                            /* TEXT */
                          )
                        ]),
                        _: 1
                        /* STABLE */
                      }),
                      createVNode(_component_v_button, {
                        loading: unref(creating),
                        disabled: backupScopeEmpty.value,
                        onClick: unref(createBackup)
                      }, {
                        default: withCtx(() => [
                          createTextVNode(
                            toDisplayString(unref(t)("backup.actions.create")),
                            1
                            /* TEXT */
                          )
                        ]),
                        _: 1
                        /* STABLE */
                      }, 8, ["loading", "disabled", "onClick"])
                    ]),
                    _: 1
                    /* STABLE */
                  })
                ]),
                _: 1
                /* STABLE */
              })
            ]),
            _: 1
            /* STABLE */
          }, 8, ["modelValue"]),
          createVNode(_component_v_dialog, {
            modelValue: unref(showRestoreDialog),
            "onUpdate:modelValue": _cache[22] || (_cache[22] = ($event) => isRef(showRestoreDialog) ? showRestoreDialog.value = $event : null),
            onEsc: _cache[23] || (_cache[23] = ($event) => showRestoreDialog.value = false)
          }, {
            default: withCtx(() => [
              createVNode(_component_v_card, null, {
                default: withCtx(() => [
                  createVNode(_component_v_card_title, null, {
                    default: withCtx(() => [
                      createTextVNode(
                        toDisplayString(unref(t)("backup.dialogs.restore_title", { label: unref(pendingRestoreManifest)?.label ?? unref(pendingRestoreId) })),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  }),
                  createVNode(_component_v_card_text, null, {
                    default: withCtx(() => [
                      createElementVNode("div", _hoisted_34, [
                        createElementVNode(
                          "div",
                          _hoisted_35,
                          toDisplayString(unref(t)("backup.scope.title_restore")),
                          1
                          /* TEXT */
                        ),
                        createVNode(ScopeFields, {
                          mode: "restore",
                          scope: unref(restoreRunScope),
                          collections: restoreCollections.value,
                          relations: unref(relations),
                          "available-components": restoreComponents.value,
                          onUpdate: updateRestoreRunScope
                        }, null, 8, ["scope", "collections", "relations", "available-components"])
                      ]),
                      createVNode(_component_v_notice, {
                        type: "warning",
                        style: { "margin-top": "0.75rem" }
                      }, {
                        default: withCtx(() => [
                          createTextVNode(
                            toDisplayString(unref(t)("backup.dialogs.restore_warning")),
                            1
                            /* TEXT */
                          )
                        ]),
                        _: 1
                        /* STABLE */
                      })
                    ]),
                    _: 1
                    /* STABLE */
                  }),
                  createVNode(_component_v_card_actions, null, {
                    default: withCtx(() => [
                      createVNode(_component_v_button, {
                        secondary: "",
                        onClick: _cache[21] || (_cache[21] = ($event) => showRestoreDialog.value = false)
                      }, {
                        default: withCtx(() => [
                          createTextVNode(
                            toDisplayString(unref(t)("backup.actions.cancel")),
                            1
                            /* TEXT */
                          )
                        ]),
                        _: 1
                        /* STABLE */
                      }),
                      createVNode(_component_v_button, {
                        kind: "danger",
                        disabled: restoreScopeEmpty.value,
                        onClick: unref(confirmRestore)
                      }, {
                        default: withCtx(() => [
                          createTextVNode(
                            toDisplayString(unref(t)("backup.actions.restore")),
                            1
                            /* TEXT */
                          )
                        ]),
                        _: 1
                        /* STABLE */
                      }, 8, ["disabled", "onClick"])
                    ]),
                    _: 1
                    /* STABLE */
                  })
                ]),
                _: 1
                /* STABLE */
              })
            ]),
            _: 1
            /* STABLE */
          }, 8, ["modelValue"]),
          createVNode(_component_v_dialog, {
            modelValue: unref(showErrorDialog),
            "onUpdate:modelValue": _cache[24] || (_cache[24] = ($event) => isRef(showErrorDialog) ? showErrorDialog.value = $event : null),
            onEsc: unref(closeError)
          }, {
            default: withCtx(() => [
              createVNode(_component_v_card, {
                class: normalizeClass(`notice-card notice-card--${unref(noticeType)}`)
              }, {
                default: withCtx(() => [
                  createVNode(_component_v_card_title, null, {
                    default: withCtx(() => [
                      createVNode(_component_v_icon, {
                        name: unref(noticeType) === "danger" ? "error" : unref(noticeType) === "warning" ? "warning" : "info",
                        class: "notice-card-icon"
                      }, null, 8, ["name"]),
                      createTextVNode(
                        " " + toDisplayString(unref(t)("backup.dialogs.error_title")),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  }),
                  createVNode(_component_v_card_text, null, {
                    default: withCtx(() => [
                      createTextVNode(
                        toDisplayString(unref(notice)),
                        1
                        /* TEXT */
                      )
                    ]),
                    _: 1
                    /* STABLE */
                  }),
                  createVNode(_component_v_card_actions, null, {
                    default: withCtx(() => [
                      createVNode(_component_v_button, { onClick: unref(closeError) }, {
                        default: withCtx(() => [
                          createTextVNode(
                            toDisplayString(unref(t)("backup.actions.close")),
                            1
                            /* TEXT */
                          )
                        ]),
                        _: 1
                        /* STABLE */
                      }, 8, ["onClick"])
                    ]),
                    _: 1
                    /* STABLE */
                  })
                ]),
                _: 1
                /* STABLE */
              }, 8, ["class"])
            ]),
            _: 1
            /* STABLE */
          }, 8, ["modelValue", "onEsc"]),
          createVNode(BackupDetailDialog, {
            modelValue: showDetailDialog.value,
            "onUpdate:modelValue": _cache[25] || (_cache[25] = ($event) => showDetailDialog.value = $event),
            item: detailItem.value
          }, null, 8, ["modelValue", "item"]),
          createVNode(ScopeDialog, {
            modelValue: showBackupScope.value,
            "onUpdate:modelValue": _cache[26] || (_cache[26] = ($event) => showBackupScope.value = $event),
            title: unref(t)("backup.scope.title_backup"),
            hint: unref(t)("backup.scope.default_scope_hint"),
            scope: backupScopeForDialog.value,
            collections: unref(collections),
            relations: unref(relations),
            onSave: onSaveBackupScope
          }, null, 8, ["modelValue", "title", "hint", "scope", "collections", "relations"]),
          unref(importEnabled) ? (openBlock(), createElementBlock(
            "input",
            {
              key: 0,
              ref_key: "uploadFileInput",
              ref: uploadFileInput,
              type: "file",
              accept: ".gz,.tgz",
              style: { "display": "none" },
              onChange: _cache[27] || (_cache[27] = //@ts-ignore
              (...args) => unref(handleFileSelected) && unref(handleFileSelected)(...args))
            },
            null,
            544
            /* NEED_HYDRATION, NEED_PATCH */
          )) : createCommentVNode("v-if", true),
          (openBlock(), createBlock(Teleport, { to: "body" }, [
            unref(restoring) ? (openBlock(), createElementBlock("div", _hoisted_36, [
              createElementVNode("div", _hoisted_37, [
                createVNode(_component_v_progress_circular, {
                  indeterminate: "",
                  class: "restore-spinner"
                }),
                createElementVNode(
                  "p",
                  _hoisted_38,
                  toDisplayString(unref(t)("backup.overlay.title")),
                  1
                  /* TEXT */
                ),
                createElementVNode("p", _hoisted_39, [
                  createTextVNode(
                    toDisplayString(unref(t)("backup.overlay.hint_restart")),
                    1
                    /* TEXT */
                  ),
                  _cache[28] || (_cache[28] = createElementVNode(
                    "br",
                    null,
                    null,
                    -1
                    /* CACHED */
                  )),
                  createTextVNode(
                    toDisplayString(unref(t)("backup.overlay.hint_reload")),
                    1
                    /* TEXT */
                  )
                ])
              ])
            ])) : createCommentVNode("v-if", true)
          ]))
        ]),
        _: 1
        /* STABLE */
      }, 8, ["title"]);
    };
  }
});

var css = "\n.backup-content[data-v-ad7da380] {\n    padding: var(--content-padding);\n    padding-top: 0;\n}\n.center[data-v-ad7da380] {\n    display: flex;\n    justify-content: center;\n    padding: 4rem 0;\n}\n.icon[data-v-ad7da380] {\n    --v-icon-color: var(--theme--foreground);\n\n    display: flex;\n    justify-content: center;\n    align-items: center;\n    width: 2rem;\n    height: 2rem;\n    border-radius: 50%;\n    background: var(--theme--background-normal);\n}\n.nav-content[data-v-ad7da380] {\n    padding: 0 var(--content-padding-half, 0.75rem);\n}\n.nav-section[data-v-ad7da380] {\n    padding: 0.75rem 0;\n}\n.nav-section + .nav-section[data-v-ad7da380] {\n    border-top: 0.063rem solid var(--theme--border-color-subdued);\n}\n.nav-section-title[data-v-ad7da380] {\n    display: flex;\n    align-items: center;\n    gap: 0.5rem;\n    margin-bottom: 0.75rem;\n    font-size: 0.875rem;\n    font-weight: 600;\n    color: var(--theme--foreground);\n}\n.nav-section-icon[data-v-ad7da380] {\n    --v-icon-color: var(--theme--foreground);\n    --v-icon-size: 1.25rem;\n}\n.nav-storage[data-v-ad7da380] {\n    display: flex;\n    flex-direction: column;\n    gap: 0.25rem;\n    font-size: 0.813rem;\n    color: var(--theme--foreground-subdued);\n}\n.nav-storage-row[data-v-ad7da380] {\n    display: flex;\n    justify-content: space-between;\n    align-items: center;\n}\n.nav-storage-label[data-v-ad7da380] {\n    font-weight: 600;\n}\n.nav-field[data-v-ad7da380] {\n    margin-bottom: 0.75rem;\n}\n.nav-field[data-v-ad7da380]:last-child {\n    margin-bottom: 0;\n}\n.nav-field-label[data-v-ad7da380] {\n    display: flex;\n    align-items: center;\n    gap: 0.25rem;\n    margin-bottom: 0.25rem;\n    font-size: 0.813rem;\n    font-weight: 600;\n    color: var(--theme--foreground-subdued);\n}\n.nav-field-help[data-v-ad7da380] {\n    --v-icon-size: 1rem;\n    --v-icon-color: var(--theme--foreground-subdued);\n\n    flex-shrink: 0;\n    opacity: 0.5;\n    cursor: help;\n    transition: opacity 0.15s;\n}\n.nav-field-help[data-v-ad7da380]:hover {\n    opacity: 1;\n}\n.nav-scope-buttons[data-v-ad7da380] {\n    display: flex;\n    flex-direction: column;\n    gap: 0.5rem;\n    padding: 0.75rem 0;\n    border-top: 0.063rem solid var(--theme--border-color-subdued);\n}\n.create-scope[data-v-ad7da380] {\n    margin-top: 1rem;\n}\n.create-scope-label[data-v-ad7da380] {\n    margin-bottom: 0.75rem;\n    font-size: 0.875rem;\n    font-weight: 600;\n    color: var(--theme--foreground);\n}\n.storage-warn[data-v-ad7da380] {\n    font-weight: 600;\n    color: var(--danger);\n}\n.storage-bar-track[data-v-ad7da380] {\n    overflow: hidden;\n    height: 0.375rem;\n    margin-top: 0.5rem;\n    border-radius: 0.188rem;\n    background: var(--theme--border-color-subdued);\n}\n.storage-bar-fill[data-v-ad7da380] {\n    height: 100%;\n    border-radius: 0.188rem;\n    transition: width 0.3s ease, background 0.3s ease;\n}\n.restored-cell[data-v-ad7da380] {\n    color: var(--theme--foreground-subdued);\n}\n.restored-cell.restored-failed[data-v-ad7da380] {\n    color: var(--danger);\n}\n.restored-empty[data-v-ad7da380] {\n    color: var(--theme--foreground-subdued);\n}\n.restored-error-hint[data-v-ad7da380] {\n    color: var(--danger);\n}\n.action-buttons[data-v-ad7da380] {\n    display: flex;\n    gap: 0.33rem;\n}\n.label-cell[data-v-ad7da380] {\n    display: flex;\n    align-items: center;\n    gap: 0.375rem;\n}\n.source-icon[data-v-ad7da380] {\n    color: var(--theme--foreground-subdued);\n}\n.status-chip[data-v-ad7da380] {\n    font-size: 0.75rem;\n    font-weight: 600;\n    text-transform: uppercase;\n}\n.status-success[data-v-ad7da380] {\n    --v-chip-color: var(--success);\n    --v-chip-background-color: var(--success-10);\n}\n.status-failed[data-v-ad7da380] {\n    --v-chip-color: var(--danger);\n    --v-chip-background-color: var(--danger-10);\n}\n.status-running[data-v-ad7da380] {\n    --v-chip-color: var(--warning);\n    --v-chip-background-color: var(--warning-10);\n}\n[data-v-ad7da380] .v-card-title {\n    margin-bottom: var(--content-padding);\n    padding-bottom: var(--content-padding);\n    padding-block-start: 0.438rem;\n    border-bottom: 0.063rem solid var(--theme--border-color, var(--border-normal));\n    font-size: 1.25rem;\n}\n.notice-card[data-v-ad7da380] {\n    border-top: 0.188rem solid transparent;\n}\n.notice-card--danger[data-v-ad7da380] {\n    border-top-color: var(--danger);\n}\n.notice-card--warning[data-v-ad7da380] {\n    border-top-color: var(--warning);\n}\n.notice-card--info[data-v-ad7da380] {\n    border-top-color: var(--primary);\n}\n.notice-card-icon[data-v-ad7da380] {\n    vertical-align: middle;\n    margin-right: 0.5rem;\n}\n.notice-card--danger .notice-card-icon[data-v-ad7da380] {\n    --v-icon-color: var(--danger);\n}\n.notice-card--warning .notice-card-icon[data-v-ad7da380] {\n    --v-icon-color: var(--warning);\n}\n.notice-card--info .notice-card-icon[data-v-ad7da380] {\n    --v-icon-color: var(--primary);\n}\n.restore-overlay[data-v-ad7da380] {\n    position: fixed;\n    display: flex;\n    justify-content: center;\n    align-items: center;\n    z-index: 9999;\n    background: var(--theme--background, #fff);\n    inset: 0;\n}\n.restore-overlay-box[data-v-ad7da380] {\n    display: flex;\n    flex-direction: column;\n    align-items: center;\n    gap: 1rem;\n    max-width: 32.5rem;\n    padding: 0 1.5rem;\n    text-align: center;\n}\n.restore-title[data-v-ad7da380] {\n    font-size: 1.125rem;\n    font-weight: 600;\n    color: var(--theme--foreground);\n}\n.restore-hint[data-v-ad7da380] {\n    font-size: 0.875rem;\n    color: var(--theme--foreground-subdued);\n    line-height: 1.6;\n}\n";
n(css,{});

var BackupModule = /* @__PURE__ */ _export_sfc(_sfc_main, [["__scopeId", "data-v-ad7da380"]]);

/**
 * Backup module registration — exposes the Backup UI in the Directus sidebar.
 * Visible to admins and users with the "Backup Access" policy.
 * @author  Frank Kudermann – alphanull
 * @version 0.9.0
 * @license AGPL-3.0-only
 */
var e0 = defineModule({
  id: "backup",
  name: "Backup",
  icon: "backup",
  preRegisterCheck: async (user) => {
    if (user.admin_access) return true;
    try {
      const res = await fetch("/backup-api/check-access");
      return res.ok;
    } catch {
      return false;
    }
  },
  routes: [
    {
      path: "",
      component: BackupModule
    }
  ]
});

const interfaces = [];const displays = [];const layouts = [];const modules = [e0];const panels = [];const themes = [];const operations = [];

export { displays, interfaces, layouts, modules, operations, panels, themes };
