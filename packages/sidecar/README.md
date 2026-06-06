# Directus Backup Sidecar

> [!WARNING]
> **Beta Software** — This project is under active development and has not been tested across all possible configurations and environments. It is **not recommended** to run this directly in a production environment without prior testing in a staging setup. Feedback, bug reports, and contributions are very welcome and greatly appreciated.

Node.js backup sidecar that runs as a Docker container alongside Directus.

For installation and configuration, see the [main documentation](../../docs/installation.md).

## Docker Image

Based on `node:22-alpine` with `postgresql16-client` for the default PostgreSQL adapter.

```sh
docker build -t directus-backup .
```

The image exposes port 4700 and runs `server.js` as the entrypoint.

## Internal API

The sidecar exposes an HTTP API on port 4700. Every route requires the `X-Backup-Secret` header **except** `GET /health`, which is intentionally unauthenticated so container healthchecks can probe it without the secret:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check — **unauthenticated**, returns only `{ "status": "ok" }` |
| `GET` | `/list` | List all backups |
| `POST` | `/run` | Start backup (body: `{ backupId, source, scope? }`) |
| `POST` | `/restore` | Start restore (body: `{ backupId, scope? }`) |
| `DELETE` | `/backup/:id` | Delete backup |
| `GET` | `/backup/:id/download` | Stream backup archive |
| `POST` | `/import` | Import (upload) a backup archive |
| `GET` | `/config` | Read config plus `importEnabled` / `exportEnabled` flags |
| `PUT` | `/config` | Update config |
| `GET` | `/storage` | Storage stats |
| `GET` | `/activity` | Activity log (`?limit=1..100`, default 100) |

> These are the sidecar's internal routes. The Directus extension exposes its own public routes (`/create`, `/:id`, `/:id/download`, `/:id/restore`, `/upload`) and proxies them to the sidecar paths above.

> **Security:** Bind the sidecar to the internal Docker network only — do not publish port 4700 to the host or the internet. The shared secret is the only authentication, and `GET /health` is reachable without it (it returns just `{ "status": "ok" }`, no lock state or backup IDs).

## Shell Scripts

- `run.sh` — generic runner: sources the DB adapter, executes backup or restore
- `restore.sh` — external restore entry point (disaster recovery without Directus Studio)
- `adapters/postgres.sh` — PostgreSQL adapter (db_init, db_backup, db_restore, db_dump_table_count, db_dump_table_list, db_counts)

See [db-adapters.md](../../docs/db-adapters.md) for the adapter interface.

## Debugging

Logs are available via `docker logs <container>`. Each backup/restore also writes a `runner.log` inside the backup directory with full stdout/stderr from `run.sh`.

Check the health endpoint:

```sh
curl http://localhost:4700/health
```

## File Structure

```
server.js          # HTTP server, cron scheduling, lock management
lib/
  config.js        # Environment config constants
  runner.js        # Child process management (run.sh), manifest I/O
  storage.js       # Quota, retention, filesystem operations
  activity.js      # Activity log
  context.js       # Runtime context (Directus container, version)
  notify.js        # Directus notification API client
adapters/
  postgres.sh      # PostgreSQL adapter
run.sh             # Backup/restore runner
restore.sh         # External restore script
Dockerfile         # Container build
```

## License

Copyright (c) 2026 Frank Kudermann / alphanull

Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only).
See the [LICENSE](LICENSE) file for details.

Commercial licensing is available for use cases not covered by the AGPL
(e.g. integration into a closed-source product or a hosted/managed service).
Contact: kudermann@alphanull.de
