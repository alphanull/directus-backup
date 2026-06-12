/**
 * Backup module registration — exposes the Backup UI in the Directus sidebar.
 * Visible to admins and users with the "Backup Access" policy.
 * @author  Frank Kudermann – alphanull
 * @version 0.10.1
 * @license AGPL-3.0-only
 */

import { defineModule } from '@directus/extensions-sdk';
import BackupModule from './BackupModule.vue';

export default defineModule({
    id: 'backup',
    name: 'Backup',
    icon: 'backup',
    preRegisterCheck: async user => {
        if (user.admin_access) return true;
        try {
            const res = await fetch('/backup-api/check-access');
            return res.ok;
        } catch {
            return false;
        }
    },
    routes: [
        {
            path: '',
            component: BackupModule
        }
    ]
});
