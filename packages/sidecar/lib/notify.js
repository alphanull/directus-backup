/**
 * Directus API helpers: version detection and in-app notifications.
 * @author   Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { BACKUP_TOKEN, ADMIN_EMAIL, DIRECTUS_URL } from './config.js';

/**
 * Fetches the running Directus version from `/server/info`.
 * Returns `null` on any error so callers can treat it as optional metadata.
 * @returns {Promise<string|null>} The Directus version string, or `null` if it could not be determined.
 */
export async function fetchDirectusVersion() {
    try {
        const res = await fetch(`${DIRECTUS_URL}/server/info`, {
            headers: { Authorization: `Bearer ${BACKUP_TOKEN}` }
        });
        if (!res.ok) return null;
        const { data } = await res.json();
        return data?.directus?.version ?? null;
    } catch (e) {
        console.warn('Could not fetch Directus version:', /** @type {Error} */ (e).message);
        return null;
    }
}

/**
 * Sends an in-app Directus notification to the admin user.
 *
 * Recipients are resolved in order:
 * 1. User with ADMIN_EMAIL (lookup by email).
 * 2. Fallback: all users with role "Administrator".
 *
 * Requires `BACKUP_TOKEN` and `ADMIN_EMAIL` to be set. All errors are caught and logged so that
 * a notification failure never interrupts the backup/restore flow.
 * @param {string} subject  Short notification title.
 * @param {string} message  Notification body / detail text.
 */
export async function notifyAdmins(subject, message) {
    if (!BACKUP_TOKEN) {
        console.warn('Notification skipped: BACKUP_TOKEN not set');
        return;
    }
    const headers = {
        Authorization: `Bearer ${BACKUP_TOKEN}`,
        'Content-Type': 'application/json'
    };
    try {
        let recipients = /** @type {string[]} */ ([]);

        if (ADMIN_EMAIL) {
            const userRes = await fetch(
                `${DIRECTUS_URL}/users?filter[email][_eq]=${encodeURIComponent(ADMIN_EMAIL)}&fields=id&limit=1`,
                { headers }
            );
            if (userRes.ok) {
                const { data: users } = await userRes.json();
                if (users?.length) recipients = [users[0].id];
            }
        }

        if (!recipients.length) {
            const adminsRes = await fetch(
                `${DIRECTUS_URL}/users?filter[role][name][_eq]=Administrator&fields=id&limit=50`,
                { headers }
            );
            if (adminsRes.ok) {
                const { data: admins } = await adminsRes.json();
                if (admins?.length) recipients = /** @type {{id: string}[]} */ (admins).map(a => a.id);
            }
        }

        if (!recipients.length) {
            console.warn('Notification skipped: no recipients (set ADMIN_EMAIL or ensure admin users exist)');
            return;
        }

        const results = await Promise.allSettled(
            recipients.map(id => fetch(`${DIRECTUS_URL}/notifications`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ recipient: id, subject, message })
            })
            )
        );
        const failed = results.filter(r => r.status === 'rejected' || r.value && !r.value.ok);
        if (failed.length) {
            console.warn(`Notification: ${failed.length}/${recipients.length} failed`);
        } else {
            console.log(`Notification sent to ${recipients.length} recipient(s): ${subject}`);
        }
    } catch (e) {
        console.warn('Failed to send notification:', /** @type {Error} */ (e).message);
    }
}
