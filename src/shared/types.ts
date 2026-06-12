/**
 * Shared type definitions for the Backup extension — the HTTP contract (DTOs)
 * between the API endpoint and the UI module.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

/** What triggered a backup or restore. */
export type BackupSource = 'manual' | 'scheduled';

/** Activity-log entry returned by the API and rendered by the UI. */
export interface ActivityEntry {
    /** ISO timestamp; added automatically on append. */
    timestamp: string
    /** Event type, e.g. `backup_success`. */
    action: string
    /** Backup ID the event refers to. */
    backupId?: string
    /** What triggered the event. */
    source?: BackupSource
    /** Additional detail or error message. */
    detail?: string
}

export interface BackupScope {
    database: boolean
    assets: boolean
    extensions: boolean
    /**
     * Collections explicitly excluded from the dump (global config scope only).
     * Empty means nothing is excluded, i.e. All collections are included.
     * New collections are automatically included because they are not in this list.
     */
    excludedCollections?: string[]
    /** Collections explicitly included in the dump; recorded in the manifest for historical display. */
    includedCollections?: string[]
    /** Positive index: collection (table) names actually contained in the dump. */
    collections?: string[]
}

/** Per-run scope selected in the UI for a manual backup or restore. */
export interface RunScope {
    database: boolean
    assets: boolean
    extensions: boolean
    /** Collections to include; empty means all collections. */
    includeCollections: string[]
}

export interface BackupVerify {
    checksums?: Record<string, string>
    dumpTables?: number
    dbCounts?: Record<string, number>
}

export interface BackupRestoreVerify {
    status: 'ok' | 'warn'
    mismatches: number
}

export interface BackupManifest {
    id: string
    createdAt: string
    label: string
    source?: BackupSource
    status: 'running' | 'success' | 'failed'
    tool?: { name: string, version?: string }
    directusVersion?: string
    sizeBytes?: number
    error?: string
    finishedAt?: string
    verify?: BackupVerify
    restoredAt?: string
    restoreStatus?: 'success' | 'failed'
    restoreError?: string
    restore?: RestoreComponents
    restoreVerify?: BackupRestoreVerify
    scope?: BackupScope
}

/** Installation sanity issue surfaced by `GET /backup-api/health`. */
export interface SanityIssue {
    /** Machine-readable issue id for UI translation. */
    code: string
    /** `error` blocks the affected operation; `warning` is informational. */
    severity: 'error' | 'warning'
    /** English fallback message for logs and untranslated UI. */
    message: string
    /** Operator-facing remediation hint (English). */
    fix?: string
    /** Optional interpolation values for localized UI strings. */
    params?: Record<string, string>
}

/** Result of the installation / dependency sanity check. */
export interface SanityReport {
    /** `true` when there are no `error`-severity issues. */
    ok: boolean
    /** `true` when manual/scheduled backups may be started. */
    operational: boolean
    /** `true` when a container-restart restore may be armed. */
    restoreReady: boolean
    issues: SanityIssue[]
    checkedAt: string
}

export type RestoreOutcome = 'restored' | 'skipped' | 'missing';

export interface RestoreComponents {
    database?: RestoreOutcome
    assets?: RestoreOutcome
    extensions?: RestoreOutcome
}
