# directus-extension-backup

Full backup and restore system for Directus. Create, schedule, download, upload, and restore backups through a UI module in Directus Studio — powered by a dedicated sidecar container that keeps Directus unblocked during all operations.

> [!WARNING]
> **Beta Software** — This project is under active development and has not been tested across all possible configurations and environments. It is **not recommended** to run this directly in a production environment without prior testing in a staging setup. Feedback, bug reports, and contributions are very welcome and greatly appreciated.

> [!IMPORTANT]
> **UI only** — the directus extension is providing only the UI module for use in directus studio. For the complete installation you also need the sidecar docker container. Please consult the  [main repo](https://github.com/alphanull/directus-backup) for complete installation instructions.

## Features

- **Complete Directus backups** — database, uploads, and extensions in a single archive
- **Full & partial restore** — restore the entire system or individual collections directly from the UI
- **Selective scope** — choose which components to include, exclude specific collections
- **Scheduled backups** — configurable intervals (hourly to weekly) with automatic retention
- **Import & Export Backups** — Download and upload backups (must be enabled manually)
- **Localized UI** — full-featured backup module built into Directus Studio, currently available in English and German
- **Integrity verification** — SHA-256 checksums + row-count comparison on every restore
- **Disaster recovery** — CLI restore script works without Directus Studio
- **Storage management** — quota limits, free-space checks, automatic rotation
- **Pluggable DB adapters** — PostgreSQL built-in, extensible for MySQL/SQLite
- **Activity Logs** — Keep track of all operations
- **Admin notifications** — in-app alerts on scheduled backup failures

## Screenshot

![Backup list with status, size, and activity log](https://raw.githubusercontent.com/alphanull/directus-backup/main/docs/images/screenshot.jpg)

## Installation

### Via Directus Marketplace

In your project's **Settings → Marketplace**, search for `backup` (or the full package name `@alphanull/directus-extension-backup`) and install it. Directus manages the installation automatically.

> [!NOTE]
> The API endpoint is **not sandboxed** (it uses direct database access for authorization and proxies to the sidecar), so a Marketplace install requires `MARKETPLACE_TRUST=all` on self-hosted instances. Directus Cloud does not allow this setting and is therefore not supported.

### Manual install

Copy the package contents — the `dist/` directory together with `package.json` — into your Directus extensions folder as `extensions/directus-extension-backup/`. The `dist/` files are committed, so no build step is required.

## API endpoints

All endpoints are mounted at `/backup-api/`. Every request requires either **admin access** or the **"Backup Access"** Directus policy assigned to the user. All endpoints proxy to the sidecar. Upload and download use streaming (no buffering in the Directus process).

| Method   | Path            | Sidecar route              | Description                               |
| -------- | --------------- | -------------------------- | ----------------------------------------- |
| `GET`    | `/list`         | `GET /list`                | List all backups (manifests, sorted)      |
| `POST`   | `/create`       | `POST /run`                | Create backup (`label`, `scope`)          |
| `POST`   | `/upload`       | `POST /import`             | Upload/import a `.tar.gz` archive         |
| `DELETE` | `/:id`          | `DELETE /backup/:id`       | Delete a backup directory                 |
| `GET`    | `/:id/download` | `GET /backup/:id/download` | Download a backup as `.tar.gz` stream     |
| `POST`   | `/:id/restore`  | `POST /restore`            | Restore a backup with optional `scope`    |
| `GET`    | `/config`       | `GET /config`              | Read backup schedule/config               |
| `PUT`    | `/config`       | `PUT /config`              | Update backup schedule/config             |
| `GET`    | `/storage`      | `GET /storage`             | Read storage usage/quota                  |
| `GET`    | `/activity`     | `GET /activity`            | Read activity log (last 50 entries)       |
| `GET`    | `/check-access` | —                          | Lightweight access check (module preload) |

## Access control

Admin users always have access. Non-admins are granted access via a Directus **access policy** named exactly `Backup Access` (`BACKUP_POLICY_NAME`). The extension does **not** create this policy — create it manually and assign it to roles and/or individual users. The policy needs no permissions or App/Admin Access of its own; the endpoint only checks that it is *assigned*.

## UI module

The Vue-based module provides a three-panel layout:

- **Left sidebar** — Status (storage usage with quota bar) and Settings (schedule, retention, quota, min free space)
- **Center** — Backup table with resizable columns (persisted in localStorage), clickable rows for detail modal, action buttons (download, restore, delete)
- **Right sidebar** — Activity log with color-coded icons (green = success, yellow = deleted, red = failed) and relative timestamps

The module is visible to admin users and users with the "Backup Access" policy (checked via `preRegisterCheck`). Polling (5s) tracks running operations and stops automatically when none remain.

## Localization

The UI supports English (fallback) and German. Translations are defined in `src/shared/translations.ts` and merged into the Directus i18n instance at runtime via `mergeLocaleMessage()`.

## Environment variables

| Variable        | Default | Description                              |
| --------------- | ------- | ---------------------------------------- |
| `BACKUP_URL`    | —       | Internal URL of the sidecar              |
| `BACKUP_SECRET` | —       | Shared secret for sidecar authentication |

These are set on the Directus service (not on the sidecar). The endpoint merges `process.env` with Directus's `context.env` (Directus overrides take precedence).

## Build & test

```bash
npm run build          # typecheck + directus-extension build
npm run dev            # watch build for local development
npm run test           # vitest (unit tests for shared utilities)
npm run test:watch     # vitest in watch mode
npm run test:coverage  # vitest coverage report
npm run typecheck      # tsc --noEmit
```

## License

Copyright (c) 2026 Frank Kudermann / alphanull

Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only).
See the [LICENSE](LICENSE) file for details.

Commercial licensing is available for use cases not covered by the AGPL
(e.g. integration into a closed-source product or a hosted/managed service).
Contact: [kudermann@alphanull.de](mailto:kudermann@alphanull.de)