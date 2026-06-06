/**
 * Shared type definitions for the Backup extension (API + module).
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

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
    source?: 'manual' | 'scheduled'
    status: 'running' | 'success' | 'failed'
    dumpFormat?: 'custom' | 'plain'
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

export type RestoreOutcome = 'restored' | 'skipped';

export interface RestoreComponents {
    database?: RestoreOutcome
    assets?: RestoreOutcome
    extensions?: RestoreOutcome
}
