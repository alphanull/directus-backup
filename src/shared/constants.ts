/**
 * Contract constants shared between the API and the module — the validation
 * rules that define valid backup IDs and labels on the wire.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

/** Matches a full backup ID: `YYYY-MM-DD__HH-MM-SS__<label>`. */
export const BACKUP_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}__[0-9]{2}-[0-9]{2}-[0-9]{2}__[a-zA-Z0-9_-]+$/;
/** Matches a backup label: alphanumeric, hyphens, and underscores only. */
export const LABEL_RE = /^[a-zA-Z0-9_-]+$/;
/** Maximum character length for a backup label. */
export const LABEL_MAX = 32;
