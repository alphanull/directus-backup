# Migration Notes

## Sidecar → Standalone

This document covers migrating from the original **sidecar architecture** (the `@alphanull/directus-extension-backup` extension plus a separate `backup` container) to the **standalone architecture** of the same `@alphanull/directus-extension-backup` package, which now runs entirely inside Directus. The npm package and Marketplace entry are unchanged — this is an in-place upgrade to a new version of the same extension, not a different package.

### What changed

| Aspect                    | Sidecar                                             | Standalone                                                             |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| Extension package         | `@alphanull/directus-extension-backup`              | `@alphanull/directus-extension-backup` (same package, new version)     |
| Extra container           | `backup` service in Compose                         | none                                                                   |
| Docker socket             | `/var/run/docker.sock:ro` on sidecar                | **not mounted anywhere**                                               |
| Authentication            | Shared `BACKUP_SECRET` between Directus + sidecar   | Directus accountability (admin or `Backup Access` policy)              |
| Directus token            | `BACKUP_TOKEN` on sidecar (notifications + version) | not needed — in-process services used instead                          |
| Restore mechanism         | Sidecar stops/starts Directus via Docker API        | Extension sends SIGTERM to PID 1 → container restart → entrypoint stub |
| Custom `Dockerfile`       | not required                                        | **required** (adds `pg_dump`/`pg_restore` + entrypoint override)       |
| `restart: unless-stopped` | on sidecar service                                  | **on Directus service** (the restart is how the restore runs)          |
| Configuration env vars    | set on **sidecar** container                        | set on **Directus** container                                          |
| Disaster recovery         | host `restore.sh` calling sidecar HTTP API          | `scripts/recover.sh` — Docker CLI only, no API required                |

### Step 1 — Remove the sidecar service

Remove the `backup` service block from your Compose file entirely. Also remove the Docker-socket volume from the Directus service if it was added there.

```yaml
# Remove completely:
backup:
  image: ghcr.io/alphanull/directus-backup:latest
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
  ...
```

### Step 2 — Add the custom Dockerfile and entrypoint

The extension needs two things the stock Directus image does not provide:

- `pg_dump` / `pg_restore` — used by the backup and restore scripts.
- A boot-time entrypoint stub — runs `restore.sh` on a clean container start, before Directus starts, when a restore is pending.

Copy `examples/Dockerfile` next to your Compose file (the entrypoint stub is embedded in it), or write it from the snippet in [installation.md](installation.md#step-2--add-the-dockerfile). Build environments without BuildKit heredoc support can use the separate `examples/entrypoint.sh` variant described there.

### Step 3 — Update the Directus service

In your Compose file, replace `image:` with `build:` and add the restart policy and backup volume:

```yaml
directus:
  # was: image: directus/directus:11.17.4
  build: .                 # builds the Dockerfile from Step 2
  restart: unless-stopped  # REQUIRED — the restore restarts this container
  volumes:
    - backups:/directus/backups  # add this
    # keep your existing uploads/extensions mounts
  ...

volumes:
  backups:  # add this
```

> `restart: unless-stopped` was previously on the `backup` sidecar service. It must now be on the **Directus** service — that is what brings the container back after the restore signal.

### Step 4 — Update environment variables

**Remove from the Directus service:**

| Variable        | Why                                               |
| --------------- | ------------------------------------------------- |
| `BACKUP_URL`    | The sidecar no longer exists                      |
| `BACKUP_SECRET` | Authentication is now via Directus accountability |

**Remove from the (now-deleted) sidecar service:**

| Variable             | Notes                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| `BACKUP_SECRET`      | Removed entirely                                                          |
| `BACKUP_TOKEN`       | Removed — in-process Directus services replace the token-based HTTP calls |
| `DIRECTUS_URL`       | Sidecar-only                                                              |
| `DIRECTUS_CONTAINER` | Sidecar-only (Docker API container name)                                  |

**Move to the Directus service** (same names, same defaults):

| Variable                                                             | Default                                                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `BACKUP_DIR`                                                         | `/directus/backups`                                                                            |
| `UPLOADS_DIR`                                                        | `/directus/uploads`                                                                            |
| `EXTENSIONS_DIR`                                                     | `/directus/extensions`                                                                         |
| `ADMIN_EMAIL`                                                        | —                                                                                              |
| `DB_ADAPTER` / `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | Directus values; only `postgres` is supported in this release                                  |
| `BACKUP_IMPORT_ENABLED`                                              | `false`                                                                                        |
| `BACKUP_EXPORT_ENABLED`                                              | `false`                                                                                        |
| `RUNNER_TIMEOUT_MIN`                                                 | `90`                                                                                           |
| ~~`BACKUP_DUMP_FORMAT`~~                                             | ~~`custom`~~ — **removed**, no longer read; the adapter always uses custom format. Do not set. |
| `CACHE_HOST` / `CACHE_PORT` / `CACHE_DB`                             | `cache` / `6379` / `0`                                                                         |
| `HOOK_POST_RESTORE_URL` / `_SECRET` / `_HINT`                        | —                                                                                              |

> Most of these are already present on your Directus service (the standard `DB_`*, `CACHE_*` variables). Only the backup-specific ones are new additions.

### Step 5 — Update the extension

The package name is unchanged (`@alphanull/directus-extension-backup`); upgrade it to the standalone version in place.

The module name, sidebar entry, and `Backup Access` policy name are unchanged — existing access policy assignments remain valid.

- **Marketplace:** update `@alphanull/directus-extension-backup` to the latest version. Requires `MARKETPLACE_TRUST=all` (same requirement as before).
- **From source:** copy `dist/`, `scripts/`, and `package.json` into `extensions/directus-extension-backup/`. The `scripts/` directory is required — the entrypoint stub from Step 2 looks it up there.

### Step 6 — Update your disaster recovery procedure

The new disaster recovery CLI is `scripts/recover.sh` (ships with the extension). It replaces the old host-side `restore.sh` from the sidecar package and the direct sidecar HTTP API call.

```sh
# Old (sidecar): host-side restore.sh that shipped with the sidecar package
BACKUP_DIR=./backups CONTAINER=<backup-container> ./restore.sh

# New (standalone):
CONTAINER=<directus-container> ./scripts/recover.sh
```

Key differences:

- It targets the **Directus** container (not the sidecar).
- It does **not** call an HTTP API — it writes the restore flag directly into the backup volume via a throwaway helper container (`--volumes-from`).
- Works even when Directus will not boot (the restore runs on the next container start, before Directus).

### Existing backup archives

Existing backup archives are fully compatible. The manifest format and directory layout are unchanged; the extension reads them without modification.

The only incompatible archives are those created with `BACKUP_DUMP_FORMAT=plain` — see the [note below](#removal-of-the-plain-dump-format).

---

## Removal of the `plain` dump format

The `plain` (`pg_dump` SQL text) format has been removed. Backups are now always
created in the PostgreSQL `custom` format (`database.dump`).

**Why:** targeted (collection-scoped) restores are not possible from a plain dump — the adapter silently escalated them to a full restore with `DROP SCHEMA public CASCADE`, risking unexpected data loss. Plain dumps also bypassed the `pg_restore --list` readability check run before every restore.

### What you need to do

- Remove `BACKUP_DUMP_FORMAT` from your environment. It is no longer read (a leftover `plain` value has no effect; nothing breaks if you leave it).

### Impact on existing backups

- Backups already created with `custom` are unaffected.
- Backups created with `plain` (containing `database.sql`) can **no longer be restored or imported**. They fail safe: restore returns `422` and does not arm a restart; import is rejected. The live database is never touched. Create a fresh backup to replace them.

### Database adapter support

This release supports PostgreSQL only. The runner keeps an internal adapter boundary, but non-PostgreSQL adapters are rejected by the installation sanity check until the API validation, documentation, examples, and test matrix support them.

For future adapter work, the `db_`* adapter contract changed — the `dump_format` argument was dropped:

- `db_backup $backup_path $include_tables $exclude_tables`
- `db_restore $backup_path $include_tables`
- `db_dump_table_count $dump_file`
- `db_dump_table_list $dump_file`

See [db-adapters.md](db-adapters.md) for the current PostgreSQL adapter and the future adapter contract.
