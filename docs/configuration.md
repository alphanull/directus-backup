# Configuration

Runtime configuration is managed through `backup-config.json` (stored in `BACKUP_DIR`), editable via the Directus Studio UI or the `PUT /backup-api/config` endpoint. Deployment-level settings (import/export gates, DB/cache connection, notifications) are environment variables on the Directus service — see [installation.md](installation.md#environment-variables).

## Config Schema

```json
{
  "schedule": "daily",
  "scheduleMinute": 0,
  "scheduleHour": 3,
  "retention": "last-5",
  "quotaMB": 1000,
  "minFreeMB": 100,
  "backupScope": {
    "database": true,
    "assets": true,
    "extensions": false,
    "excludedCollections": ["analytics_events"]
  }
}
```

| Field            | Default   | Description                                                                                         |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `schedule`       | `"off"`   | Cron preset: `off`, `1h`, `6h`, `12h`, `daily`, `3d`, `weekly`                                      |
| `scheduleMinute` | `0`       | Minute offset for sub-daily schedules (0–59)                                                        |
| `scheduleHour`   | `0`       | Hour for daily+ schedules (0–23)                                                                    |
| `retention`      | `"all"`   | Auto-delete policy for scheduled backups: `all`, `last-3`, `last-5`, `last-10`, `days-7`, `days-30` |
| `quotaMB`        | `0`       | Max total size of the backup folder in MB. `0` = unlimited                                          |
| `minFreeMB`      | `100`     | Minimum free space on the volume in MB before blocking new backups                                  |
| `backupScope`    | see below | Default scope for scheduled backups and component defaults for manual backups                       |

## Scope

`backupScope` is the global default applied to scheduled backups. For manual backups it pre-fills the component toggles (`database`, `assets`, `extensions`); collections always start fully selected and can be narrowed for that run. There is no global restore scope — the scope for a manual backup and for a restore is chosen per run.

| Field                 | Default | Description                                                                                                                                                         |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`            | `true`  | Include database dump                                                                                                                                               |
| `assets`              | `true`  | Include uploads (assets)                                                                                                                                            |
| `extensions`          | `false` | Include extensions directory                                                                                                                                        |
| `excludedCollections` | `[]`    | Collections (tables) to exclude from the dump. Empty = all included. New collections that appear later are automatically included (they are not in this blocklist). |

The global config scope is **blocklist-based** (`excludedCollections`): everything is included except the listed collections. The per-run backup and restore scopes are **allowlist-based** (`includeCollections`): the UI checkbox state directly represents what is included. The module converts between the two so a checked box always means "included".

### Per-run scopes

- **Manual backup:** component toggles are prefilled from `backupScope`; collections start fully selected regardless of the global `excludedCollections`. Changes apply only to that run and are not written back to the global config.
- **Restore:** the dialog shows exactly what the backup contains. Components are offered only if present in the backup, and the selectable collections come from the backup's positive index (`scope.collections`) — there is no comparison against the live schema.

Collections excluded during backup are absent from the dump. A full restore performs `DROP SCHEMA public CASCADE` and recreates only what the dump contains, so an excluded collection is not present afterwards. A targeted (partial) restore only touches the selected tables and leaves everything else untouched.

### Non-Directus tables

The collection scope UI is populated from the Directus `/collections` API, which only lists tables registered in Directus. Tables that exist in PostgreSQL but are **not** registered in Directus (e.g. PostGIS tables such as `spatial_ref_sys`, or custom tables added outside Directus) are **not shown** in the scope UI and **cannot be excluded** via the UI.

These tables are always included in the dump (`pg_dump` operates on the full schema unless an explicit `--exclude-table` is provided, which is only set for `excludedCollections`). On a full restore they are restored transparently; on a targeted restore they are left untouched. This is intentional for the common case — extension tables are usually static schema objects that should be backed up and restored together with application data.

## Scheduling and Retention

- **Scheduling** is handled by `node-cron` inside the extension. Changing the schedule via the UI triggers an immediate reschedule. In a PM2 cluster, only the worker with `NODE_APP_INSTANCE` unset or `0` schedules backups, so a cron fires once regardless of worker count (see [architecture.md](architecture.md#scheduling)).
- **Retention** only affects scheduled backups; manual backups are never auto-deleted.
- After each successful scheduled backup, the retention policy removes the oldest scheduled backups that exceed the configured limit.

## Storage Quota

Two independent limits are checked before every backup:

1. **Folder quota** (`quotaMB`) — total size of all backups in the backup directory.
2. **Free space** (`minFreeMB`) — available space on the underlying volume.

When a limit is hit:

- **Scheduled backups:** oldest scheduled backups are rotated until space is available. If still not enough, the backup is skipped with a log warning.
- **Manual backups:** rejected immediately with HTTP 507 and a clear error message.

## Import / Export Controls

Two operator-controlled kill-switches gate the operations that move archives across the trust boundary. Both are **environment variables on the Directus service**, **secure-by-default OFF**, and enabled only by the explicit values `true` or `1`. Because they are deployment-level settings (not part of `backup-config.json`), a user holding only the `Backup Access` policy cannot re-enable them through the UI or the config API.

| Variable                | Default | Effect when disabled                                                                                                           |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `BACKUP_IMPORT_ENABLED` | off     | `/upload` returns HTTP 403 (`IMPORT_DISABLED`); the UI hides the upload button. Removes the only ingress for foreign archives. |
| `BACKUP_EXPORT_ENABLED` | off     | `/:id/download` returns HTTP 403 (`EXPORT_DISABLED`); the UI hides the download button. Removes the bulk-exfiltration path.    |

The endpoint is the authoritative boundary; the Studio UI honors the same flags (surfaced via `GET /backup-api/config` as `importEnabled` / `exportEnabled`) but is not the enforcement point. Creating, scheduling, restoring, and deleting self-created backups are unaffected. See [security.md](security.md#import--export-controls) for the risk discussion.

## Upload Size (Import)

> ⚠️ Import must be enabled (`BACKUP_IMPORT_ENABLED=true`) for this path to be reachable.

Imported archives are sent to the endpoint with `Content-Type: application/gzip` and streamed straight to disk. Directus applies its `MAX_PAYLOAD_SIZE` limit only to `application/json` bodies (via the global `express.json()` middleware), so it does **not** cap import size on Directus 11.17.4 — verified end-to-end in `test/integration/run.sh` with `MAX_PAYLOAD_SIZE=1mb` and a ~2 MB gzip upload. The effective guard is the `minFreeMB` free-space check (HTTP 507). If you run custom body-parsing middleware, verify large imports against your setup.

## Notifications & Version Detection

Running inside Directus, the extension uses the **in-process Directus services** — there is no static token and no HTTP round-trip (the sidecar's `BACKUP_TOKEN` does not exist here).

1. **Failure notifications** — when a scheduled backup fails, an in-app notification (backup ID + error message) is sent via the in-process `NotificationsService`.
2. **Version detection** — the running Directus version is read via the in-process `ServerService` and stored in the backup manifest.

Recipients are resolved by `ADMIN_EMAIL`: the user with that email is looked up. `ADMIN_EMAIL` is optional — if unset or no matching user is found, all users with the role `Administrator` are notified instead. Both features are best-effort: any failure is logged and never interrupts the backup/restore flow.

## Post-Restore Webhook (optional)

After a successful restore the extension can fire a webhook for integration with external systems.

| Variable                   | Default | Description                                                       |
| -------------------------- | ------- | ----------------------------------------------------------------- |
| `HOOK_POST_RESTORE_URL`    | —       | Full webhook URL called via `POST` after a successful restore     |
| `HOOK_POST_RESTORE_SECRET` | —       | Sent as the `X-Webhook-Secret` header for authentication          |
| `HOOK_POST_RESTORE_HINT`   | —       | Recovery hint included in admin notifications when the hook fails |

Behavior: fire-and-forget with error handling — a failing hook does not affect the restore result. Only the HTTP status code is evaluated (2xx = success). On failure or timeout, an in-app notification is sent to admins with the error and the recovery hint. If `HOOK_POST_RESTORE_URL` is unset, the hook is silently skipped.

> ⚠️  **Security note:** the hook URL is configured by the operator through the Directus environment. Anyone who can change that environment already controls a highly privileged deployment boundary, but the setting still gives the Directus container an outbound network capability. Point it only at trusted endpoints, prefer HTTPS, treat `HOOK_POST_RESTORE_SECRET` as a rotatable secret, and use deployment-level egress controls if the container must not reach internal services or cloud metadata endpoints.
