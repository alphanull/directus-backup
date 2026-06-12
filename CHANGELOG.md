# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org) and follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## [0.10.0] – 2026-06-12

### Added

- **Standalone architecture for `@alphanull/directus-extension-backup`** — self-contained backup & restore that runs entirely within Directus; no sidecar container, no Docker socket required (same package name as before; the sidecar is removed)
- **Sidecar-free restore lifecycle:** Extension arms a `.pending_restore` flag and sends `SIGTERM` to PID 1; `restart: unless-stopped` brings the container back up; a custom `entrypoint.sh` intercepts the flag and runs the restore script before Directus starts — guaranteeing zero DB connections at restore time
- **Two-phase restore validation** before the Point-of-No-Return (`DROP SCHEMA`): manifest `status=success`, SHA-256 checksum, `pg_restore --list` readability check (exit 0), and DB reachability — any failure aborts with a UI error and leaves the DB untouched
- **Post-restore verification:** table-count comparison against `db-counts.txt`; mismatches are recorded as `restoreVerify.status: "warn"` in the manifest so operators can see drift without turning an otherwise completed restore into a failed run
- **Cluster-safe scheduler:** `node-cron` is only registered on `NODE_APP_INSTANCE === 0` (or `undefined`) to prevent duplicate scheduled backups in PM2 cluster mode; schedule and retention settings are stored in `backup-config.json` on the backup volume, so a database restore cannot wipe them
- **Startup sanity check** (`src/api/core/sanity.ts`): verifies required tools (`pg_dump`, `pg_restore`, `psql`, `tar`, `sha256sum`, `df`), optional Redis helper (`nc`), `setsid` when restore timeout enforcement is enabled, runner scripts, adapter availability, backup directory writability, and restore bootstrap readiness; missing requirements are surfaced as a structured report
- **Shell test suite** expanded with dedicated runner tests: `restore-result.test.sh`, `path-decoupling.test.sh`, `recover-flag-env.test.sh`, `restore-timeout.test.sh`; adapter test: `postgres-restore.test.sh`
- **Direct restore reconciliation tests** for `.restore_done`, `.restore_failed`, `.restore_processing`, and stale `.pending_restore` outcomes, including manifest updates, activity entries, lock release, marker cleanup, and post-restore hook firing
- **Integration test harness** (`test/integration/`) with Dockerfile, Compose file, and entrypoint fixture for end-to-end container-level testing
- **Migration guide** (`docs/migration.md`) for users moving from the sidecar-based extension
- **Example files** (`examples/`) including a reference `Dockerfile`, `entrypoint.sh`, and two Compose variants (standalone and add-on)
- **Integration-test hardening:** restore log gates no longer use `grep -q` under `pipefail`, avoiding false failures when `docker compose logs` receives `SIGPIPE` after an early match

### Removed

- Separate sidecar package/container and Docker socket dependency
- Sidecar-only environment variables (`BACKUP_SECRET`, `BACKUP_URL`, `BACKUP_TOKEN`, `DIRECTUS_URL`, `DIRECTUS_CONTAINER`)
- Plain SQL dump restore support (`BACKUP_DUMP_FORMAT=plain`); PostgreSQL backups are now created and restored as custom-format `database.dump`
- `dockerode` dependency

### Fixed

- Restart-based restore instructions now consistently reference `scripts/restore.sh` as the boot-time runner and `scripts/recover.sh` as the host-side disaster recovery CLI
- `scripts/recover.sh` no longer writes default `UPLOADS_DIR` / `EXTENSIONS_DIR` values into `.pending_restore`, so disaster recovery restores assets/extensions into the container's configured paths instead of always using `/directus/uploads` and `/directus/extensions`
- Restore overlay polling in the Studio module now exits after 15 minutes with a warning if Directus does not become reachable again, instead of blocking the browser UI indefinitely on stuck restarts, network failures, or persistent 5xx responses
- The Studio module now fails closed when `GET /backup-api/health` is unreachable or returns no report: backup/restore actions are disabled and an installation error banner is shown instead of enabling actions against an unknown installation state
- Restore start errors in the Studio module now use the same structured error translation path as create/upload actions, so codes such as `ALREADY_RUNNING` and `INSTALL_INCOMPLETE` show localized messages
- Restore detail labels now include the `missing` component state, matching the runner/API restore result values instead of rendering the raw `backup.restore_state.missing` translation key
- Backup table sorting now compares numeric values numerically, so the size column no longer sorts values lexicographically (for example, `100` before `99`)
- Background polling now refreshes the backup list silently on transient API failures, preventing repeated error dialogs during sustained outages while preserving visible errors for initial loads and user-triggered refreshes
- Startup recovery now removes corrupt but validly named lock files (for example, a truncated `.locks/LIVE_DB.lock`) so a crash during lock writes cannot permanently block future backup/restore operations
- Startup recovery now removes partial import directories and stale `.upload-*.tar.gz` temp files left by an interrupted upload/import, preventing orphaned data from consuming quota or surfacing as a broken backup
- Failed backup runs now remove their partial backup directory after recording the error in activity/notifications, preventing repeated failures from consuming storage quota until manual cleanup
- Restore-from-file UI now respects restore readiness: the upload action and restore dialog confirmation are disabled when `restoreReady=false`, and `confirmRestore()` also guards against race/programmatic starts
- Direct restore API calls now reject empty component scopes instead of arming a no-op restore that would restart the container and report success without changing anything
- Download streaming now delays the `200` response headers until `tar` emits archive data, so startup failures can still return a JSON `500` instead of a truncated gzip with status `200`
- Import streaming now falls back to the configured `quotaMB` budget when free-space probing via `df` is unavailable, reducing unbounded writes in constrained container environments
- Boot-time restores now fail closed when `RUNNER_TIMEOUT_MIN` is enabled but `setsid` is unavailable, preventing unbounded restores; `RUNNER_TIMEOUT_MIN=0` remains the explicit opt-out

### Changed

- Package layout consolidated from the previous multi-package sidecar structure into one Directus bundle package at the repository root
- Published npm packages now include `examples/` alongside `dist/`, `scripts/`, and `docs/*.md`, so installation and sanity guidance can reference shipped example files
- Documentation now focuses on the standalone trust model: no sidecar service, no extra HTTP port, no Docker socket, and deployment-level import/export gates
- Documentation now calls out the optional post-restore webhook as an operator-controlled outbound network capability and describes the related egress/secret-handling considerations
- Database support is now stated explicitly as PostgreSQL-only for this release; unsupported `DB_ADAPTER` values fail the installation sanity check instead of being treated as supported plugins

---

## [0.9.0] – 2026-06-06

### Added

- This marks the first release of **Directus Backup**
- **Localized UI** — full-featured backup module built into Directus Studio, currently available in English and German
- **Complete Directus backups** — database, uploads, and extensions in a single archive
- **Selective scope** — choose which components to include, exclude specific collections
- **Scheduled backups** — configurable intervals (hourly to weekly) with automatic retention
- **Import & Export Backups** — Download and upload backups (must be enabled manually)
- **Full & partial restore** — restore the entire system or individual collections directly from the UI
- **Integrity verification** — SHA-256 checksums + row-count comparison on every restore
- **Disaster recovery** — CLI restore script works without Directus Studio
- **Storage management** — quota limits, free-space checks, automatic rotation
- **Pluggable DB adapters** — PostgreSQL built-in, extensible for MySQL/SQLite
- **Activity Logs** — Keep track of all operations
- **Admin notifications** — in-app alerts on scheduled backup failures
