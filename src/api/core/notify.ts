/**
 * Directus API helpers: version detection and in-app notifications.
 *
 * The sidecar talked to Directus over HTTP with a static token. Running inside
 * Directus, the extension uses the in-process services and database instead, so
 * no token and no network round-trip are needed.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { config } from './config.js';
import { getRuntime } from './runtime.js';

/**
 * Fetches the running Directus version via the in-process `ServerService`.
 * Best-effort: returns `null` on any error so callers treat it as optional
 * manifest metadata (identical contract to the sidecar's HTTP-based lookup).
 * @returns The Directus version string, or `null` if it could not be determined.
 */
export async function fetchDirectusVersion(): Promise<string | null> {
    try {
        const { services, getSchema, database } = getRuntime();
        const { ServerService } = services;
        if (!ServerService) return null;
        const schema = await getSchema();
        const server = new ServerService({
            accountability: { admin: true, role: null, user: null },
            schema,
            knex: database
        });
        const info = await server.serverInfo();
        return info?.version ?? info?.directus?.version ?? null;
    } catch (e) {
        getRuntime().logger?.warn?.(`Could not fetch Directus version: ${(e as Error).message}`);
        return null;
    }
}

/**
 * Resolves notification recipient user IDs.
 *
 * Order (mirrors the sidecar):
 * 1. The user whose email equals `ADMIN_EMAIL`, if configured.
 * 2. Fallback: all users whose role is named `Administrator`.
 * @returns Recipient user IDs (may be empty).
 */
async function resolveRecipients(): Promise<string[]> {
    const { database } = getRuntime();

    if (config.adminEmail) {
        const user = await database('directus_users')
            .where('email', config.adminEmail)
            .select('id')
            .first();
        if (user?.id) return [user.id];
    }

    const admins = await database('directus_users')
        .join('directus_roles', 'directus_users.role', 'directus_roles.id')
        .where('directus_roles.name', 'Administrator')
        .limit(50)
        .pluck('directus_users.id');

    return Array.isArray(admins) ? admins : [];
}

/**
 * Sends an in-app Directus notification to the admin user(s).
 *
 * All errors are caught and logged so a notification failure never interrupts
 * the backup/restore flow.
 * @param subject  Short notification title.
 * @param message  Notification body / detail text.
 */
export async function notifyAdmins(subject: string, message: string): Promise<void> {
    const { services, getSchema, database, logger } = getRuntime();
    try {
        const recipients = await resolveRecipients();
        if (!recipients.length) {
            logger?.warn?.('Notification skipped: no recipients (set ADMIN_EMAIL or ensure an "Administrator" role exists)');
            return;
        }

        const { NotificationsService } = services;
        if (!NotificationsService) {
            logger?.warn?.('Notification skipped: NotificationsService unavailable');
            return;
        }

        const schema = await getSchema();
        const notifications = new NotificationsService({
            accountability: { admin: true, role: null, user: null },
            schema,
            knex: database
        });

        await notifications.createMany(recipients.map(recipient => ({ recipient, subject, message })));
        logger?.info?.(`Notification sent to ${recipients.length} recipient(s): ${subject}`);
    } catch (e) {
        logger?.warn?.(`Failed to send notification: ${(e as Error).message}`);
    }
}
