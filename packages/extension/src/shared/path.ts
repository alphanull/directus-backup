/**
 * Path validation utilities — backup ID validation and traversal-safe resolution.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { BACKUP_ID_RE } from './constants.js';

/**
 * Returns true if the ID matches the allowed backup-ID pattern.
 */
export function isValidBackupId(id: string): boolean {
    return typeof id === 'string' && BACKUP_ID_RE.test(id);
}
