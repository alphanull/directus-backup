/**
 * Activity-log entry type shared between the API endpoint and the UI module.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

export interface ActivityEntry {
    timestamp: string
    action: string
    backupId?: string
    source?: 'manual' | 'scheduled'
    detail?: string
}
