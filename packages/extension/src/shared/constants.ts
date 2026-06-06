/**
 * Constants for the Backup extension — regex patterns, file names, limits.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

/** Matches a full backup ID: `YYYY-MM-DD__HH-MM-SS__<label>`. */
export const BACKUP_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}__[0-9]{2}-[0-9]{2}-[0-9]{2}__[a-zA-Z0-9_-]+$/;
/** Matches a backup label: alphanumeric, hyphens, and underscores only. */
export const LABEL_RE = /^[a-zA-Z0-9_-]+$/;
/** Maximum character length for a backup label. */
export const LABEL_MAX = 32;
/** Directus policy name that grants access to the Backup module UI + API. */
export const BACKUP_POLICY_NAME = 'Backup Access';
