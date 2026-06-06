/* eslint-disable @stylistic/max-len */
/**
 * UI translation strings (English + German) for the backup module, merged into
 * the Directus i18n instance at runtime.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import type { useI18n } from 'vue-i18n';

const enUS = {
    backup: {
        title: 'Backups',
        nav: {
            status: 'Status',
            settings: 'Settings'
        },
        actions: {
            restore_from_file: 'Restore from File',
            uploading: 'Uploading…',
            create_backup: 'Create Backup',
            download: 'Download',
            restore: 'Restore',
            delete: 'Delete',
            cancel: 'Cancel',
            cancel_backup: 'Cancel Backup',
            close: 'Close',
            create: 'Create',
            configure: 'Configure…'
        },
        settings: {
            schedule: 'Schedule',
            at_minute: 'At minute',
            at_hour: 'At hour',
            retention: 'Retention',
            quota_mb: 'Quota (MB)',
            min_free_mb: 'Min. free (MB)',
            quota_placeholder: '0 = unlimited',
            label_placeholder: 'Optional label (e.g. pre-deploy, vor-migration)',
            backup_scope: 'Default Scope',
            tooltips: {
                schedule: 'How often automatic backups are created.',
                at_minute: 'Within each interval, start the backup at this minute (0–59).',
                at_hour: 'Within each interval, start the backup at this UTC hour (0–23).',
                retention: 'How many backups to keep. Older backups are deleted automatically once the limit is reached.',
                quota_mb: 'Maximum total storage used by all backup files combined (MB). New backups are blocked when this limit is reached. 0 = no limit.',
                min_free_mb: 'Minimum free disk space (MB) required on the volume before a backup starts. Checked independently of the quota — prevents backups when the disk is nearly full.',
                backup_scope: 'Default scope for scheduled backups: which components (database, assets, extensions) and collections are included. Manual backups use individual settings.'
            }
        },
        schedule: {
            off: 'Off',
            hourly: 'Hourly',
            every_6h: 'Every 6 hours',
            every_12h: 'Every 12 hours',
            daily: 'Daily',
            every_3d: 'Every 3 days',
            weekly: 'Weekly'
        },
        retention: {
            all: 'Keep all',
            last_3: 'Keep last 3',
            last_5: 'Keep last 5',
            last_10: 'Keep last 10',
            days_7: 'Last 7 days',
            days_30: 'Last 30 days'
        },
        table: {
            label: 'Label',
            status: 'Status',
            size: 'Size',
            created: 'Created',
            restored: 'Restored',
            actions: 'Actions'
        },
        storage: {
            used: 'Used',
            free: 'Free'
        },
        status: {
            success: 'success',
            failed: 'failed',
            running: 'running',
            restore_failed: '(failed)'
        },
        restore_state: {
            restored: 'restored',
            skipped: 'skipped'
        },
        detail: {
            id: 'ID',
            source: 'Source',
            created: 'Created',
            finished: 'Finished',
            duration: 'Duration',
            size: 'Size',
            directus: 'Directus',
            format: 'Format',
            tool: 'Tool',
            error: 'Error',
            restored: 'Restored',
            restore_section: 'Restore',
            restore_error: 'Restore Error',
            restore_components: 'Components',
            component_database: 'Database',
            component_assets: 'Assets',
            component_extensions: 'Extensions',
            scope: 'Scope',
            included_collections: 'Included',
            excluded_collections: 'Excluded'
        },
        dialogs: {
            error_title: 'Error',
            delete_title: 'Delete Backup',
            delete_confirm: 'Are you sure you want to delete {id}? This cannot be undone.',
            create_title: 'Create Backup',
            restore_title: 'Restore {label}',
            restore_warning: 'Directus will be stopped during the restore and restarted afterwards. Do not close this tab. The page will reload automatically when done.'
        },
        overlay: {
            title: 'Restore in progress\u2026',
            hint_restart: 'Directus is restarting. Please do not reload the page.',
            hint_reload: 'This page will reload automatically when done.'
        },
        notices: {
            no_backups: 'No backups yet.',
            load_failed: 'Failed to load backups',
            config_save_failed: 'Failed to save config',
            already_running: 'Backup already running.',
            create_failed: 'Backup creation failed',
            upload_failed: 'Upload failed',
            delete_failed: 'Delete failed',
            cancel_failed: 'Cancel failed',
            restore_failed: 'Restore failed to start'
        },
        errors: {
            QUOTA_EXCEEDED: 'Storage limit reached: usage {used} MB >= quota {quota} MB',
            QUOTA_IMPORT_EXCEEDED: 'Storage limit reached: usage {used} MB + import {import} MB > quota {quota} MB',
            DISK_FULL: 'Not enough free disk space: {free} MB free, minimum {min} MB required',
            ALREADY_RUNNING: 'Another backup or restore is already running.',
            IMPORT_DISABLED: 'Backup import is disabled by the server configuration.',
            EXPORT_DISABLED: 'Backup export is disabled by the server configuration.'
        },
        scope: {
            title_backup: 'Default Scope',
            title_create: 'Backup Scope',
            title_restore: 'Restore Scope',
            default_scope_hint: 'For manual backups, individual settings apply.',
            database: 'Database',
            assets: 'Assets',
            extensions: 'Extensions',
            include_collections: 'Included Collections',
            search_placeholder: 'Search collections…',
            no_selections: 'No collections selected — all collections will be included.',
            select_all: 'Select all',
            select_none: 'Clear',
            dependency_warning_intro: 'Deselected collections are still linked to selected ones:',
            dependency_warning_hint_backup: 'Consider including them again to keep the backup consistent.',
            dependency_warning_hint_restore: 'Consider including them again to avoid breaking references.',
            save: 'Save'
        },
        activity: {
            title: 'Activity',
            backup_success: 'Backup completed',
            backup_failed: 'Backup failed',
            backup_cancelled: 'Backup cancelled',
            delete: 'Backup deleted',
            upload: 'Backup imported',
            restore_success: 'Restore completed',
            restore_failed: 'Restore failed',
            config: 'Settings changed',
            error: 'Error',
            empty: 'No activity yet.',
            source_manual: 'Manual',
            source_scheduled: 'Scheduled'
        }
    }
};

const deDE = {
    backup: {
        title: 'Backups',
        nav: {
            status: 'Status',
            settings: 'Einstellungen'
        },
        actions: {
            restore_from_file: 'Aus Datei wiederherstellen',
            uploading: 'Hochladen…',
            create_backup: 'Backup erstellen',
            download: 'Herunterladen',
            restore: 'Wiederherstellen',
            delete: 'Löschen',
            cancel: 'Abbrechen',
            cancel_backup: 'Backup abbrechen',
            close: 'Schließen',
            create: 'Erstellen',
            configure: 'Konfigurieren…'
        },
        settings: {
            schedule: 'Zeitplan',
            at_minute: 'Zur Minute',
            at_hour: 'Zur Stunde',
            retention: 'Aufbewahrung',
            quota_mb: 'Kontingent (MB)',
            min_free_mb: 'Min. frei (MB)',
            quota_placeholder: '0 = unbegrenzt',
            label_placeholder: 'Optionale Bezeichnung (z.\u00a0B. pre-deploy, vor-migration)',
            backup_scope: 'Standard-Umfang',
            tooltips: {
                schedule: 'Wie häufig automatische Backups erstellt werden.',
                at_minute: 'Innerhalb des Intervalls: Backup startet zu dieser Minute (0–59).',
                at_hour: 'Innerhalb des Intervalls: Backup startet zu dieser Stunde (0–23, UTC).',
                retention: 'Wie viele Backups aufbewahrt werden. Ältere Backups werden automatisch gelöscht, sobald das Limit erreicht ist.',
                quota_mb: 'Maximaler Gesamtspeicher aller Backup-Dateien zusammen (MB). Neue Backups werden blockiert, wenn dieses Limit erreicht ist. 0 = unbegrenzt.',
                min_free_mb: 'Mindestens verfügbarer freier Speicherplatz (MB) auf dem Datenträger vor einem Backup. Wird unabhängig vom Kontingent geprüft — verhindert Backups bei nahezu vollem Datenträger.',
                backup_scope: 'Standard-Umfang für geplante Backups: Komponenten (Datenbank, Assets, Erweiterungen) und Collections. Für manuelle Backups gelten individuelle Einstellungen.'
            }
        },
        schedule: {
            off: 'Aus',
            hourly: 'Stündlich',
            every_6h: 'Alle 6 Stunden',
            every_12h: 'Alle 12 Stunden',
            daily: 'Täglich',
            every_3d: 'Alle 3 Tage',
            weekly: 'Wöchentlich'
        },
        retention: {
            all: 'Alle behalten',
            last_3: 'Letzte 3 behalten',
            last_5: 'Letzte 5 behalten',
            last_10: 'Letzte 10 behalten',
            days_7: 'Letzte 7 Tage',
            days_30: 'Letzte 30 Tage'
        },
        table: {
            label: 'Bezeichnung',
            status: 'Status',
            size: 'Größe',
            created: 'Erstellt',
            restored: 'Wiederhergestellt',
            actions: 'Aktionen'
        },
        storage: {
            used: 'Belegt',
            free: 'Frei'
        },
        status: {
            success: 'Erfolgreich',
            failed: 'Fehlgeschlagen',
            running: 'Läuft',
            restore_failed: '(fehlgeschlagen)'
        },
        restore_state: {
            restored: 'wiederhergestellt',
            skipped: 'übersprungen'
        },
        detail: {
            id: 'ID',
            source: 'Quelle',
            created: 'Erstellt',
            finished: 'Abgeschlossen',
            duration: 'Dauer',
            size: 'Größe',
            directus: 'Directus',
            format: 'Format',
            tool: 'Werkzeug',
            error: 'Fehler',
            restored: 'Wiederhergestellt',
            restore_section: 'Wiederherstellung',
            restore_error: 'Wiederherstellungsfehler',
            restore_components: 'Komponenten',
            component_database: 'Datenbank',
            component_assets: 'Assets',
            component_extensions: 'Erweiterungen',
            scope: 'Umfang',
            included_collections: 'Eingeschlossen',
            excluded_collections: 'Ausgeschlossen'
        },
        dialogs: {
            error_title: 'Fehler',
            delete_title: 'Backup löschen',
            delete_confirm: 'Soll {id} wirklich gelöscht werden? Dies kann nicht rückgängig gemacht werden.',
            create_title: 'Backup erstellen',
            restore_title: '{label} wiederherstellen',
            restore_warning: 'Directus wird während der Wiederherstellung gestoppt und danach neu gestartet. Schließen Sie diesen Tab nicht. Die Seite wird automatisch neu geladen.'
        },
        overlay: {
            title: 'Wiederherstellung läuft\u2026',
            hint_restart: 'Directus wird neu gestartet. Bitte laden Sie die Seite nicht neu.',
            hint_reload: 'Diese Seite wird automatisch neu geladen, sobald der Vorgang abgeschlossen ist.'
        },
        notices: {
            no_backups: 'Noch keine Backups vorhanden.',
            load_failed: 'Backups konnten nicht geladen werden',
            config_save_failed: 'Konfiguration konnte nicht gespeichert werden',
            already_running: 'Backup läuft bereits.',
            create_failed: 'Backup-Erstellung fehlgeschlagen',
            upload_failed: 'Upload fehlgeschlagen',
            delete_failed: 'Löschen fehlgeschlagen',
            cancel_failed: 'Abbrechen fehlgeschlagen',
            restore_failed: 'Wiederherstellung konnte nicht gestartet werden'
        },
        errors: {
            QUOTA_EXCEEDED: 'Speicherlimit erreicht: Belegung {used} MB >= Kontingent {quota} MB',
            QUOTA_IMPORT_EXCEEDED: 'Speicherlimit erreicht: Belegung {used} MB + Import {import} MB > Kontingent {quota} MB',
            DISK_FULL: 'Zu wenig freier Speicherplatz: {free} MB frei, Minimum {min} MB erforderlich',
            ALREADY_RUNNING: 'Ein anderes Backup oder eine Wiederherstellung läuft bereits.',
            IMPORT_DISABLED: 'Der Backup-Import ist in der Serverkonfiguration deaktiviert.',
            EXPORT_DISABLED: 'Der Backup-Export ist in der Serverkonfiguration deaktiviert.'
        },
        scope: {
            title_backup: 'Standard-Umfang',
            title_create: 'Backup-Umfang',
            title_restore: 'Restore-Umfang',
            default_scope_hint: 'Für manuelle Backups gelten individuelle Einstellungen.',
            database: 'Datenbank',
            assets: 'Assets',
            extensions: 'Extensions',
            include_collections: 'Eingeschlossene Collections',
            search_placeholder: 'Collections suchen…',
            no_selections: 'Keine Collections ausgewählt — alle Collections werden eingeschlossen.',
            select_all: 'Alle auswählen',
            select_none: 'Auswahl löschen',
            dependency_warning_intro: 'Abgewählte Collections sind noch verknüpft mit:',
            dependency_warning_hint_backup: 'Erwägen Sie, sie wieder einzuschließen, um ein konsistentes Backup zu gewährleisten.',
            dependency_warning_hint_restore: 'Erwägen Sie, sie wieder einzuschließen, um Referenzen nicht zu beschädigen.',
            save: 'Speichern'
        },
        activity: {
            title: 'Aktivität',
            backup_success: 'Backup abgeschlossen',
            backup_failed: 'Backup fehlgeschlagen',
            backup_cancelled: 'Backup abgebrochen',
            delete: 'Backup gelöscht',
            upload: 'Backup importiert',
            restore_success: 'Wiederherstellung abgeschlossen',
            restore_failed: 'Wiederherstellung fehlgeschlagen',
            config: 'Einstellungen geändert',
            error: 'Fehler',
            empty: 'Noch keine Aktivität.',
            source_manual: 'Manuell',
            source_scheduled: 'Geplant'
        }
    }
};

let merged = false;

/** Merges the backup module's en-US and de-DE messages into the i18n instance (once). */
export function mergeBackupTranslations(i18n: ReturnType<typeof useI18n>) {
    if (merged) return;
    merged = true;

    i18n.mergeLocaleMessage('en-US', enUS);
    i18n.mergeLocaleMessage('de-DE', deDE);
}
