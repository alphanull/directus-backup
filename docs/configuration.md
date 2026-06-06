# Configuration

All configuration is managed through `backup-config.json`, editable via the Directus Studio UI or the `PUT /backup-api/config` endpoint.

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

| Field | Default | Description |
|---|---|---|
| `schedule` | `"off"` | Cron preset: `off`, `1h`, `6h`, `12h`, `daily`, `3d`, `weekly` |
| `scheduleMinute` | `0` | Minute offset for sub-daily schedules (0-59) |
| `scheduleHour` | `0` | Hour for daily+ schedules (0-23) |
| `retention` | `"all"` | Auto-delete policy for scheduled backups: `all`, `last-3`, `last-5`, `last-10`, `days-7`, `days-30` |
| `quotaMB` | `0` | Max total size of backup folder in MB. `0` = unlimited |
| `minFreeMB` | `100` | Minimum free space on the volume in MB before blocking new backups |
| `backupScope` | see below | Default scope for scheduled backups and component defaults for manual backups |

## Scope

`backupScope` is the global default applied to scheduled backups. For manual backups, it pre-fills the component toggles (`database`, `assets`, `extensions`); collections always start fully selected and can be narrowed for that run. There is no global restore scope: the scope for a manual backup and for a restore is chosen per run.

| Field | Default | Description |
|---|---|---|
| `database` | `true` | Include database dump |
| `assets` | `true` | Include uploads (assets) |
| `extensions` | `false` | Include extensions directory |
| `excludedCollections` | `[]` | Database collections (tables) to exclude from the dump. Empty means all collections are included. New collections that appear later are automatically included because they are not in this blocklist. |

The global config scope is **blocklist-based** (`excludedCollections`): everything is included except the listed collections. The per-run backup and restore scopes are **allowlist-based** (`includeCollections`): the UI checkbox state directly represents what is included. The module converts between the two so that a checked box always means "included".

### Per-run scopes

- **Manual backup**: component toggles are prefilled from `backupScope`; collections start fully selected, regardless of the global `excludedCollections` blocklist. Changes apply only to that run and are not written back to the global config.
- **Restore**: the dialog shows exactly what the backup contains. Components are offered only if present in the backup, and the selectable collection list comes from the backup's positive index (`scope.collections` in the manifest) -- there is no comparison against the live schema.

Collections excluded during backup are absent from the dump. A full restore performs `DROP SCHEMA public CASCADE` and recreates only what the dump contains, so an excluded collection is not present after a full restore. A targeted (partial) restore only touches the selected tables and leaves everything else untouched.

### Non-Directus tables

The collection scope UI is populated from the Directus `/collections` API, which only lists tables that are registered in Directus. Tables that exist in the PostgreSQL database but are **not** registered in Directus (e.g. PostGIS extension tables such as `spatial_ref_sys`, `topology`, `layer`, or custom tables added outside of Directus) are **not shown** in the scope UI and **cannot be excluded** via the UI.

These tables are always included in the dump (pg_dump operates on the full schema unless an explicit `--exclude-table` flag is provided, which is only set for tables in `excludedCollections`). On a full restore they are restored transparently alongside the Directus collections. On a targeted (partial) restore they are left untouched in the live database.

This is intentional for the common case — extension tables are typically static schema objects that should always be backed up and restored together with the application data. If you need to exclude specific non-Directus tables (e.g. a large table managed by an external application), this is a known limitation; see the planned enhancements in the project README.

## Scheduling and Retention

- **Scheduling** is handled by `node-cron` inside the sidecar. Changing the schedule via the UI triggers an immediate cron reschedule.
- **Retention** only affects scheduled backups. Manual backups are never auto-deleted.
- After each successful scheduled backup, the retention policy is enforced, removing the oldest scheduled backups that exceed the configured limit.

## Storage Quota

Two independent limits are checked before every backup:

1. **Folder quota** (`quotaMB`) -- total size of all backups in the backup directory
2. **Free space** (`minFreeMB`) -- available space on the underlying volume/filesystem

When a limit is hit:

- **Scheduled backups:** Oldest scheduled backups are rotated (deleted) until space is available. If still not enough: backup is skipped with a log warning.
- **Manual backups:** Rejected immediately with HTTP 507 and a clear error message.

## Import / Export Controls

Two operator-controlled kill-switches gate the two operations that move backup archives across the trust boundary. Both are **environment variables on the sidecar**, are **secure-by-default OFF**, and are only enabled by the explicit values `true` or `1`. Because they are deployment-level settings (not part of `backup-config.json`), a user holding only the `Backup Access` policy cannot re-enable them through the UI or the config API.

| Variable | Default | Effect when disabled |
|---|---|---|
| `BACKUP_IMPORT_ENABLED` | off | Sidecar `/import` returns HTTP 403 (`IMPORT_DISABLED`); the UI hides the upload button. Removes the only ingress for foreign, externally supplied archive contents. |
| `BACKUP_EXPORT_ENABLED` | off | Sidecar `/backup/:id/download` returns HTTP 403 (`EXPORT_DISABLED`); the UI hides the download button. Removes the bulk-exfiltration path (full database + assets download). |

The sidecar is the authoritative boundary; the extension proxy and the Studio UI honor the same flags (surfaced via `GET /backup-api/config` as `importEnabled` / `exportEnabled`) but are not the enforcement point. Creating, scheduling, restoring, and deleting self-created backups are unaffected by these switches.

## Upload Size (Import)

> Import must be enabled (`BACKUP_IMPORT_ENABLED=true`) for this path to be reachable; see [Import / Export Controls](#import--export-controls).

Imported archives are sent to the Directus API endpoint with `Content-Type: application/gzip` and streamed straight through to the sidecar. Directus applies its `MAX_PAYLOAD_SIZE` limit via the global `express.json()` middleware, which only reads/limits bodies whose content type is `application/json`. Because the upload uses `application/gzip`, that middleware does not buffer or size-limit it — so `MAX_PAYLOAD_SIZE` does **not** cap import size on the current Directus versions inspected (verified against the Directus `api/src/app.ts` source, not end-to-end tested across all versions).

The effective guard is on the sidecar side: an upload is rejected once it would consume the configured `minFreeMB` free-space margin on the backup volume (HTTP 507). If you run a non-standard Directus configuration with custom body-parsing middleware, verify large imports against your setup.

## Notifications & Version Detection

`BACKUP_TOKEN` is an **optional** static Directus access token. When set, the sidecar uses it for two independent things:

1. **Failure notifications** -- when a scheduled backup fails, an in-app notification (backup ID + error message) is sent via the Directus notifications API.
2. **Version detection** -- the running Directus version is read from `/server/info` and stored in the backup manifest.

Notification recipients are resolved by `ADMIN_EMAIL`: the user with that email is looked up in Directus. `ADMIN_EMAIL` is itself optional -- if it is unset or no matching user is found, all users with the role "Administrator" are notified instead.

### Required token permissions

The token belongs to a Directus user, but that user does **not** need to be an admin. It only needs a policy granting:

| Operation | Collection | Used for |
|---|---|---|
| Read | `directus_users` | Resolve recipients by email / role |
| Read | `directus_roles` | Resolve the "Administrator" fallback |
| Create | `directus_notifications` | Send the notification |

Version detection needs no collection permissions -- `/server/info` returns the version to any authenticated request.

### When the token is unset

If `BACKUP_TOKEN` is absent (or Directus is unreachable), both features are simply skipped with a logged warning. The backup and restore process itself is never affected.
