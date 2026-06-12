# Architecture

The system is a **single Directus extension** that runs entirely inside the Directus container. It bundles a Vue UI module, an API endpoint, and the shell scripts that do the actual backup/restore work. There is no sidecar container and no Docker socket.

> **Why a restart-based restore?** A restore must drop and reload the database, which cannot happen safely while Directus holds open connections. Instead of stopping Directus from the outside (the sidecar used the Docker socket for this), the extension arms a restore and restarts its own container; the restore then runs from the entrypoint on the clean boot, *before* Directus starts.

## Components

| Component               | Location                       | Role                                                                                                           |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **UI Module**           | `src/module/`                  | Vue 3 page in Directus Studio — backup list, restore, settings, scope config, activity log, storage info       |
| **API Endpoint**        | `src/api/`                     | Mounted at `/backup-api/` — authorizes users, manages locks/manifests, spawns `backup.sh`, arms restores       |
| **Backup runner**       | `scripts/backup.sh`            | Performs the backup via the DB adapter; computes checksums and verification data                               |
| **Restore runner**      | `scripts/restore.sh`           | Runs on a clean boot before Directus starts when a restore is pending; performs the restore via the DB adapter |
| **PostgreSQL adapter**  | `scripts/adapters/postgres.sh` | PostgreSQL dump/restore implementation. PostgreSQL is the only supported database adapter in this release      |
| **Recovery CLI**        | `scripts/recover.sh`           | Host-side disaster recovery — arms a restore without Directus Studio                                           |

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Directus container                                                  │
│                                                                      │
│  Studio (Vue module)  ←→  /backup-api/*  (in-process API endpoint)   │
│                                  │                                   │
│        authorize (directus_policies / directus_access)               │
│        NotificationsService / ServerService (in-process)             │
│                                  │                                   │
│      ┌───────────────────────────┴───────────────────────────────┐   │
│      │ lock manager (.locks/)   manifest writes (backup.json)    │   │
│      │ quota / retention        node-cron (scheduled backups)    │   │
│      │ backup.sh  ──  adapters/${DB_ADAPTER}.sh                  │   │
│      │       ├── db_backup / db_restore                          │   │
│      │       ├── uploads.tar.gz / extensions.tar.gz              │   │
│      │       └── checksums.sha256 + db-counts.txt + db-tables.txt│   │
│      └───────────────────────────────────────────────────────────┘   │
│                                                                      │
│  entrypoint.sh → restore.sh (runs a pending restore on boot)         │
└──────────────┬───────────────────────────┬───────────────────────────┘
               │                            │
               ▼                            ▼
          BACKUP_DIR                  uploads/ & extensions/
        (backup volume)                 (Directus volumes)
```

The database and Redis cache are the same instances Directus already uses; the extension reuses Directus's `DB_*` / `CACHE_*` settings. PostgreSQL is the only supported database adapter in this release.

## API endpoints

All endpoints are mounted at `/backup-api/`. Every request requires either **admin access** or the **Backup Access** policy. Upload and download use streaming (no buffering in the Directus process).


| Method   | Path            | Description                                   |
| -------- | --------------- | --------------------------------------------- |
| `GET`    | `/list`         | List all backups (manifests, sorted)          |
| `POST`   | `/create`       | Create backup (`label`, `scope`)              |
| `POST`   | `/upload`       | Upload/import a `.tar.gz` archive             |
| `DELETE` | `/:id`          | Delete a backup directory                     |
| `GET`    | `/:id/download` | Download a backup as a `.tar.gz` stream       |
| `POST`   | `/:id/restore`  | Restore a backup with optional `scope`        |
| `POST`   | `/:id/cancel`   | Cancel a running backup                       |
| `GET`    | `/config`       | Read config + `importEnabled`/`exportEnabled` |
| `PUT`    | `/config`       | Update config                                 |
| `GET`    | `/storage`      | Read storage usage/quota                      |
| `GET`    | `/activity`     | Read activity log (`?limit=1..100`)           |
| `GET`    | `/check-access` | Lightweight access check (module preload)     |
| `GET`    | `/health`       | Installation and restore-readiness report     |

## Backup Data Flow

1. User clicks "Create Backup" in the UI (or cron triggers a scheduled backup).
2. The endpoint authorizes the request, generates a timestamped ID (`YYYY-MM-DD__HH-MM-SS__label`).
3. The endpoint checks quota (folder size + free space). Scheduled backups may rotate old scheduled backups if more space is needed; manual backups fail fast when quota is exceeded.
4. It acquires the live-system lock (`LIVE_DB`) and writes the initial manifest with `status: running`.
5. It spawns `backup.sh` as a child process with DB credentials and scope env vars.
6. `backup.sh` calls the adapter's `db_backup` to create the dump.
7. `backup.sh` creates `uploads.tar.gz` (skipped if assets excluded) and `extensions.tar.gz` (skipped if extensions excluded).
8. `backup.sh` computes SHA-256 checksums and the verification data (`db_dump_table_count`, `db_dump_table_list` → `db-tables.txt`, `db_counts`).
9. On exit 0 the endpoint reads the verify data, finalizes the manifest, and releases the lock.
10. (Optional) The user cancels a running backup: the endpoint SIGTERMs the process group; `monitorProcess()` detects the cancellation, removes the partial directory, releases `LIVE_DB`, and logs `backup_cancelled`.
11. After a successful scheduled backup, the retention policy is enforced.

## Restore Data Flow

The restore is split across two container lifecycles: **validate + arm** (Directus up) and **execute** (clean boot).

1. User clicks "Restore" (or `scripts/recover.sh` arms it externally).
2. **While Directus is up**, the endpoint validates the backup (see [security.md](security.md#pre-restore-validation-before-the-point-of-no-return)): manifest `status: success`, checksum match, `pg_restore --list` for custom dumps, and DB reachability.
3. It acquires the `LIVE_DB` lock and the backup's per-ID lock, then writes the run-specific restore env to the `.pending_restore` flag file in `BACKUP_DIR`.
4. It schedules a container restart by sending `SIGTERM` to **PID 1** (`pm2-runtime`) after the HTTP response is sent.
5. The `restart: unless-stopped` policy restarts the container. On the clean boot, the `entrypoint.sh` stub detects the flag and runs `restore.sh` **before** Directus starts.
6. `restore.sh` claims the flag (rename to `.restore_processing`, the crash-loop guard) and sources the run env.
7. `restore.sh` verifies checksums (aborts on mismatch), then calls the adapter's `db_restore` — full restore if no collections are selected, targeted data-only restore otherwise — and restores `uploads.tar.gz` / `extensions.tar.gz`, recording per-component outcomes in `restore-result.txt`. The restore body runs under a wall-clock watchdog (`RUNNER_TIMEOUT_MIN`); on timeout the whole restore process group is terminated so a hung runner cannot block the boot, and the run is marked failed.
8. `restore.sh` flushes the Directus Redis cache (`FLUSHDB` on `CACHE_DB`, skipped if `CACHE_HOST` is empty) and writes the result marker (`.restore_done` / `.restore_failed`).
9. The stub `exec`s the real Directus entrypoint; Directus starts against the restored database.
10. On the next Directus boot the endpoint **reconciles** the manifest from the marker (it is the single owner of `backup.json`), records `restoreStatus` and the per-component `restore` object, releases the locks, and — if configured — fires the post-restore hook.

## Backup Filesystem Layout

```text
backups/                              # BACKUP_DIR (backup volume)
├── .locks/                           # One lock file per active operation (LIVE_DB + backup IDs)
├── .pending_restore                  # Restore flag (KEY=VALUE run env); transient
├── .restore_processing               # In-progress claim (crash-loop guard); transient
├── .restore_done / .restore_failed   # Result marker for the extension to reconcile; transient
├── backup-config.json                # Schedule, retention, quota settings
├── backup-activity.jsonl             # Append-only activity log
└── 2026-02-20__14-30-00__manual/
    ├── backup.json                   # Manifest (source of truth)
    ├── database.dump                 # Binary dump (pg_dump custom format)
    ├── uploads.tar.gz                # Compressed uploads directory
    ├── extensions.tar.gz             # Compressed extensions directory
    ├── checksums.sha256              # SHA-256 hashes (sha256sum -c compatible)
    ├── db-counts.txt                 # Row counts for 10 system tables + dump table count
    ├── db-tables.txt                 # Positive index: collection (table) names in the dump
    ├── restore-result.txt            # Written after restore: per-component outcome
    ├── restore-error.txt             # Written only on restore failure
    └── runner.log                    # Full stdout/stderr of backup.sh
```

The handshake files (`.pending_restore`, `.restore_processing`, `.restore_done`, `.restore_failed`) live in `BACKUP_DIR` deliberately — that volume survives the restart that arms the restore.

## Concurrency & Locking

Locks are per-resource files under `backups/.locks/`. Two domains coexist:

- `**LIVE_DB**` — a single global lock held by **backup** and **restore**, the operations that mutate the shared database. It guarantees no two of them run at once, regardless of backup ID.
- **Per-backup-ID** — a lock named after a backup ID, held by **restore** (its source backup), **download**, **delete**, and **import** (the ID from the uploaded archive). It serializes operations that touch a single backup directory. Import takes only this lock, never `LIVE_DB`, because it does not touch the live database.

A restore holds both and always acquires `LIVE_DB` before the backup ID, so the acquisition order is total and deadlock-free. Unrelated operations run concurrently (e.g. downloading one backup while another is created).

On startup, `recoverStaleLocks()` treats every lock as stale (a child process cannot survive a container restart): it marks an interrupted backup/restore in the manifest, finishes an interrupted delete, and clears each lock. Afterwards `reconcileRunningManifests()` marks any manifest still at `status: "running"` as failed — the safety net for a terminal manifest write that failed after its lock was already released.

> **Restore + restart interaction.** A restore intentionally leaves its locks held across the restart; they are the recovery anchor. On the boot after the restore, the endpoint reconciles the manifest from the result marker and only then releases them. If the marker is missing (e.g. the entrypoint never ran), `recoverStaleLocks()` cleans up on a later start.

## Scheduling

Scheduled backups use `node-cron` inside the extension. In a PM2 **cluster** deployment every worker would otherwise schedule the same backup, so scheduling is **cluster-aware**: only the instance with `NODE_APP_INSTANCE` unset or `0` arms the cron and runs startup recovery. Changing the schedule via the UI reschedules immediately on that instance.

## Activity Log

The extension maintains an append-only activity log (`backup-activity.jsonl`) recording operations with timestamps, action types, backup IDs, and source (manual vs. scheduled). Logged actions include `backup_success`, `backup_failed`, `backup_cancelled`, `delete`, `upload`, `restore_success`, `restore_failed`, and `config`. The UI sidebar shows the most recent entries.

## Manifest Schema

```json
{
  "id": "2026-02-20__14-30-00__manual",
  "createdAt": "2026-02-20T14:30:00.000Z",
  "label": "manual",
  "source": "manual",
  "status": "success",
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
    "checksums": { "database.dump": "70f148…", "uploads.tar.gz": "9412ec…" },
    "dumpTables": 82,
    "dbCounts": { "directus_collections": 53, "directus_fields": 559 }
  },
  "restoredAt": "2026-02-20T15:00:00.000Z",
  "restoreStatus": "success",
  "restore": { "database": "restored", "assets": "restored", "extensions": "skipped" },
  "restoreVerify": { "status": "ok", "mismatches": 0 }
}
```

| Field           | Description                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`         | Components included at backup time. Manual backups record `includedCollections` (allowlist; empty = all); scheduled backups using the global config record `excludedCollections` (blocklist). `collections` is the positive index of table names in the dump, used by the restore UI. |
| `tool.name`     | The DB adapter used (e.g. `postgres`).                                                                                                                                                                                                                                                |
| `restoreStatus` | `"success"` or `"failed"`. A requested component whose file is absent aborts the restore as `"failed"`.                                                                                                                                                                               |
| `restore`       | Per-component outcome after a successful restore: each of `database`, `assets`, `extensions` is `"restored"` or `"skipped"`.                                                                                                                                                          |
| `restoreVerify` | Present after a successful restore. `status` is `"warn"` when row counts differ — count mismatches are non-blocking.                                                                                                                                                                  |
| `source`        | `"manual"` for user-triggered, `"scheduled"` for cron-triggered backups.                                                                                                                                                                                                              |

## Verification

**File checksums (`checksums.sha256`):** SHA-256 hashes of all backup files, verified before any restore begins. A mismatch is fatal — the restore aborts and the database is not touched.

**Table row counts (`db-counts.txt`):** exact `SELECT COUNT(*)` for 10 critical Directus system tables, captured at backup time and re-queried after a restore. Mismatches are non-fatal warnings (`restoreVerify.status: "warn"`). The 10 tables: `directus_collections`, `directus_fields`, `directus_relations`, `directus_policies`, `directus_roles`, `directus_users`, `directus_access`, `directus_permissions`, `directus_flows`, `directus_settings`.

**Positive collection index (`db-tables.txt`):** the bare table names of the data tables in the dump, surfaced as `scope.collections`. It lets the restore UI offer exactly the collections present in the backup without comparing against the (possibly diverged) live schema.

## Security

See [security.md](security.md) for the full reference. Archive extraction (`tar xzf`) uses no ownership or permission override flags; files are extracted with the permissions stored in the archive and owned by whatever user `restore.sh` runs as.

In the standard image, that is the `node` user.
