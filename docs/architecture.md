# Architecture

The system is split into two packages: a **Directus extension** (UI module + API endpoint) that runs inside Directus, and a **sidecar container** that owns all backup logic. The extension handles authentication and proxies requests; the sidecar holds the database credentials, shared volumes, and Docker socket access required to actually perform backups and restores. This separation keeps Directus unblocked during long-running operations and allows restores to stop and restart the Directus container independently.

## Components


| Component        | Package               | Role                                                                                                                                              |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UI Module**    | `packages/extension/` | Vue 3 page in Directus Studio -- backup list, restore, settings, scope config, activity log, storage info                                         |
| **API Endpoint** | `packages/extension/` | Thin proxy -- generates IDs, authenticates users, forwards to sidecar                                                                             |
| **Sidecar**      | `packages/sidecar/`   | Always-on service -- lock management, manifest writes, DB backup/restore via run.sh + adapter, scheduling, retention, quota, scope, notifications |
| **restore.sh**   | `packages/sidecar/`   | External restore script -- works without Directus Studio                                                                                          |


## System Overview

```
┌────────────────────────────────────────────────────────────────────┐
│  Directus                                                          │
│                                                                    │
│  Studio (Vue module)  ←→  /backup-api/*  (endpoint: auth proxy)    │
│                                                                    │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │  HTTP :4700   X-Backup-Secret
                                   ▼
┌────────────────────────────────────────────────────────────────────┐
│  Sidecar                                                           │
│                                                                    │
│  server.js                                                         │
│    ├── node-cron                        scheduled backups          │
│    ├── lock manager                     .locks/                    │
│    ├── quota / retention                backup-config.json         │
│    ├── Directus API client              failure notifications      │
│    └── run.sh  ──  adapters/${DB_ADAPTER}.sh                       │
│              ├── db_backup / db_restore                            │
│              ├── uploads.tar.gz                                    │
│              ├── extensions.tar.gz                                 │
│              └── checksums.sha256 + db-counts.txt + db-tables.txt  │
│                                                                    │
└──────────┬─────────────────────┬──────────────────┬────────────────┘
           │                     │                  │
           ▼                     ▼                  ▼
     BACKUP_DIR            uploads/ &          Docker socket
     (shared vol)          extensions/         stop / start Directus
                           (shared vols)       on restore
```

## Backup Data Flow

1. User clicks "Create Backup" in the UI (or cron triggers a scheduled backup)
2. API endpoint generates a timestamped ID (`YYYY-MM-DD__HH-MM-SS__label`), forwards to sidecar
3. Sidecar checks quota (folder size + free space), rotates old scheduled backups if needed
4. Sidecar acquires the live-system lock (`LIVE_DB`), writes initial manifest with `status: running`
5. Sidecar spawns `run.sh` as a child process with DB credentials and scope env vars
6. `run.sh` calls the DB adapter's `db_backup` to create the database dump
7. `run.sh` creates `uploads.tar.gz` (skipped if assets excluded in scope)
8. `run.sh` creates `extensions.tar.gz` (skipped if extensions excluded in scope)
9. `run.sh` computes SHA-256 checksums for all backup files
10. `run.sh` calls `db_dump_table_count`, `db_dump_table_list` (positive collection index -> `db-tables.txt`), and `db_counts` for verification data
11. On exit (code 0), sidecar reads verify data and finalizes manifest, releases lock

11a. (Optional) User cancels the backup via the UI: sidecar sends SIGTERM to the process group; `monitorProcess()` detects the cancellation, removes the partial backup directory, releases `LIVE_DB`, and logs a `backup_cancelled` activity entry. The backup disappears from the list.
12. After successful scheduled backups: retention policy is enforced

## Restore Data Flow

1. User clicks "Restore" in the UI, or runs `restore.sh` externally
2. Sidecar validates backup (must exist, `status: success`)
3. Sidecar acquires the live-system lock (`LIVE_DB`) and the backup's own per-ID lock, stops the Directus container via Docker socket
4. Sidecar determines the restore scope from the per-run request. Component toggles are clamped to what the backup contains. Collection filters are intersected with `scope.includedCollections` when that allowlist exists; otherwise the request's `includeCollections` is used as sent by the UI.
5. Sidecar spawns `run.sh` with `RUNNER_MODE=restore`
6. `run.sh` verifies checksums -- aborts immediately if any file is corrupt
7. `run.sh` calls the DB adapter's `db_restore` (full restore if `includeCollections` is empty; targeted data-only restore for specific tables otherwise)
8. `run.sh` restores `uploads.tar.gz`, recording the outcome as `restored` or `skipped` (not requested); a requested component whose file is absent aborts the restore hard (`exit 1`)
9. `run.sh` restores `extensions.tar.gz` the same way; per-component outcomes are written to `restore-result.txt`
10. `run.sh` calls `db_counts` and compares to backup counts
11. Sidecar flushes the Directus Redis cache (`FLUSHDB` on `CACHE_DB`, default `0`)
12. Sidecar starts the Directus container
13. Sidecar reads `restore-result.txt`, derives `restoreStatus` (`success` / `failed`) and the per-component `restore` object, writes them to the manifest, releases lock
14. If configured, sidecar fires the post-restore hook (`HOOK_POST_RESTORE_URL`)

## Filesystem Layout

```
backups/
├── .locks/                       # One lock file per active operation (LIVE_DB + backup IDs)
├── backup-config.json            # Schedule, retention, quota settings
└── 2026-02-20__14-30-00__manual/
    ├── backup.json               # Manifest (source of truth)
    ├── database.dump             # Binary dump (default)
    │   or database.sql           # Plain SQL dump (BACKUP_DUMP_FORMAT=plain)
    ├── uploads.tar.gz            # Compressed uploads directory
    ├── extensions.tar.gz         # Compressed extensions directory
    ├── checksums.sha256          # SHA-256 hashes (sha256sum -c compatible)
    ├── db-counts.txt             # Row counts for 10 system tables + dump table count
    ├── db-tables.txt             # Positive index: collection (table) names in the dump
    ├── restore-verify.txt        # Written after restore: mismatch count + details
    ├── restore-result.txt        # Written after restore: per-component outcome (restored|skipped)
    ├── restore-error.txt         # Written only on restore failure
    └── runner.log                # Full stdout/stderr of run.sh
```

## Concurrency & Locking

Locks are per-resource files under `backups/.locks/`. Two domains coexist:

- `**LIVE_DB**` — a single global lock held by **backup** and **restore**, the operations that mutate the shared database and Directus container. It guarantees that no two of them run at once, regardless of backup ID.
- **Per-backup-ID** — a lock named after a backup ID, held by **restore** (its source backup), **download**, **delete**, and **import** (the ID extracted from the uploaded archive). It serializes operations that touch a single backup directory. Import takes only this lock, never `LIVE_DB`, because it does not touch the live database.

A restore holds both and always acquires `LIVE_DB` before the backup ID, so the acquisition order is total and deadlock-free. Unrelated operations run concurrently — for example, downloading one backup while another is being created.

On startup, `recoverStaleLocks()` treats every lock as stale (a child process cannot survive a container restart): it marks an interrupted backup/restore in the manifest, finishes an interrupted delete by removing the directory, and then clears each lock. Afterwards `reconcileRunningManifests()` marks any manifest still left at `status: "running"` as failed — the safety net for a backup whose terminal manifest write failed after its lock was already released, which would otherwise have no lock to recover from.

**Cancel** does not acquire any additional lock — it sends SIGTERM to the already-running child process group. `monitorProcess()` detects the cancellation flag, removes the partial backup directory, and releases `LIVE_DB`. If the sidecar restarts during a cancel, `recoverStaleLocks()` finds the `LIVE_DB` lock, attempts to read the manifest (returning `null` if the directory was already deleted), and releases the lock normally — leaving no stale state behind.

## Activity log

The sidecar maintains an append-only activity log (`backup-activity.jsonl`) that records all backup operations with timestamps, action types, backup IDs, and source information (manual vs. scheduled).

Logged actions: `backup_success`, `backup_failed`, `delete`, `upload`, `restore_success`, `restore_failed`, `config`.

The UI sidebar displays the last 50 entries, updated via the existing 5-second polling cycle (active only when a backup operation is running).

## Manifest Schema

```json
{
  "id": "2026-02-20__14-30-00__manual",
  "createdAt": "2026-02-20T14:30:00.000Z",
  "label": "manual",
  "source": "manual",
  "status": "success",
  "dumpFormat": "custom",
  "tool": { "name": "postgres" },
  "directusVersion": "11.15.2",
  "scope": {
    "database": true,
    "assets": true,
    "extensions": false,
    "excludedCollections": ["analytics_events"],
    "collections": ["articles", "authors", "directus_users"]
  },
  "sizeBytes": 152395482,
  "finishedAt": "2026-02-20T14:30:45.000Z",
  "verify": {
    "checksums": {
      "database.dump": "70f148...",
      "uploads.tar.gz": "9412ec..."
    },
    "dumpTables": 82,
    "dbCounts": {
      "directus_collections": 53,
      "directus_fields": 559
    }
  },
  "restoredAt": "2026-02-20T15:00:00.000Z",
  "restoreStatus": "success",
  "restore": {
    "database": "restored",
    "assets": "restored",
    "extensions": "skipped"
  },
  "restoreVerify": {
    "status": "ok",
    "mismatches": 0
  }
}
```


| Field           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scope`         | Records which components were included at backup time. Manual backups record `includedCollections` (allowlist; empty means all); scheduled backups using the global config scope record `excludedCollections` (blocklist; empty means none excluded). `collections` is the positive index of collection (table) names actually contained in the dump; the restore UI uses it to show exactly the backup contents. Backend restore clamping currently intersects requested collections with `includedCollections` when that allowlist is present. |
| `tool.name`     | The DB adapter used (e.g. `postgres`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `restoreStatus` | `"success"` or `"failed"`. On failure, `restoreError` contains a human-readable message. A requested component whose file is absent from the backup (only possible on a manipulated/truncated backup, since import enforces scope/content consistency) aborts the restore as `"failed"`.                                                                                                                                                                                                                                                         |
| `restore`       | Per-component outcome, present after a successful restore. Each of `database`, `assets`, `extensions` is `"restored"` or `"skipped"` (not requested by the restore scope).                                                                                                                                                                                                                                                                                                                                                                       |
| `restoreVerify` | Only present after a successful restore. `status` is `"warn"` when counts differ -- count mismatches are non-blocking.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `source`        | `"manual"` for user-triggered, `"scheduled"` for cron-triggered backups.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |


## Verification

Every backup includes two types of integrity data:

**File checksums (`checksums.sha256`):**
SHA-256 hashes of all backup files. Verified before any restore begins. A mismatch is fatal -- the restore is aborted immediately and the database is not touched.

**Table row counts (`db-counts.txt`):**
Exact `SELECT COUNT(*)` results for 10 critical Directus system tables captured at backup time. After a successful restore, the same counts are queried and compared. Mismatches are non-fatal warnings -- the restore is considered complete, but `restoreVerify.status` is set to `"warn"`.

The 10 tables checked: `directus_collections`, `directus_fields`, `directus_relations`, `directus_policies`, `directus_roles`, `directus_users`, `directus_access`, `directus_permissions`, `directus_flows`, `directus_settings`.

**Positive collection index (`db-tables.txt`):**
The bare table names of the data tables contained in the dump, one per line, captured at backup time. Collections excluded at backup time are absent from the dump and therefore from this list. It is surfaced in the manifest as `scope.collections` and lets the restore UI offer exactly the collections that are in the backup, without comparing against the (possibly diverged) live schema.

## Security

See [security.md](security.md) for the full security reference.

Archive extraction uses `-o` (`--no-same-owner`), `--no-same-permissions`, and `-h` (`--dereference`), so restored files are owned by the sidecar user with default permissions.