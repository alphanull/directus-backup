/**
 * Request authorization: Directus admins pass; everyone else is checked against
 * the "Backup Access" policy.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import type { Response } from 'express';
import { BACKUP_POLICY_NAME } from '../core/config.js';

/** Subset of the Directus request used by the backup routes. */
export interface AccountableRequest {
    accountability?: { admin?: boolean, user?: string | null, roles?: string[] }
    body?: Record<string, unknown>
    params: Record<string, string>
    query?: Record<string, string>
}

/**
 * Authorizes the request: admins pass, otherwise the Backup Access policy is checked.
 * @param req       The accountable request.
 * @param res       Express response (used to send 403 on failure).
 * @param database  Knex instance for the policy lookup.
 * @returns         `true` if access is granted, `false` (and a 403 sent) otherwise.
 */
export async function requireBackupAccess(req: AccountableRequest, res: Response, database: any): Promise<boolean> {
    const acc = req.accountability;
    if (acc?.admin) return true;

    const userId = acc?.user ?? null;
    const roles = acc?.roles ?? [];

    if (!userId && roles.length === 0) {
        res.status(403).json({ error: 'Forbidden' });
        return false;
    }

    const query = database('directus_access')
        .join('directus_policies', 'directus_access.policy', 'directus_policies.id')
        .where('directus_policies.name', BACKUP_POLICY_NAME)
        .andWhere(function(this: any) {
            if (roles.length > 0) this.whereIn('directus_access.role', roles);
            if (userId) this.orWhere('directus_access.user', userId);
        })
        .first();

    if (!await query) {
        res.status(403).json({ error: 'Forbidden' });
        return false;
    }
    return true;
}
