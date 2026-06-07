# Installation

## Prerequisites

- Docker and Docker Compose
- A running Directus instance (v11+)
- PostgreSQL (other databases via adapters — see [db-adapters.md](db-adapters.md))

> **Example files:** The `[examples/](../examples/)` directory contains ready-to-use Compose snippets (`docker-compose.yml`, `docker-compose.backup.yml`) and a commented `.env.example`. The steps below explain each setting.

## Step 1 — Add the Sidecar Service

Add the `backup` service to your `docker-compose.yml`:

```yaml
backup:
  image: ghcr.io/alphanull/directus-backup:latest
  restart: unless-stopped
  volumes:
    - ./backups:/directus/backups
    - /var/run/docker.sock:/var/run/docker.sock:ro
    - ./uploads:/directus/uploads
    - ./extensions:/directus/extensions
  environment:
    BACKUP_SECRET: ${BACKUP_SECRET}
    BACKUP_DIR: /directus/backups
    UPLOADS_DIR: /directus/uploads
    EXTENSIONS_DIR: /directus/extensions
    DIRECTUS_URL: http://directus:8055
    DIRECTUS_CONTAINER: ${COMPOSE_PROJECT_NAME}-directus-1
    BACKUP_TOKEN: ${BACKUP_TOKEN}
    ADMIN_EMAIL: ${ADMIN_EMAIL}
    BACKUP_DUMP_FORMAT: ${BACKUP_DUMP_FORMAT:-custom}
    DB_HOST: database
    DB_USER: ${DB_USER}
    DB_PASSWORD: ${DB_PASSWORD}
    DB_DATABASE: ${DB_DATABASE}
  depends_on:
    - directus
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4700/health"]
    interval: 30s
    timeout: 5s
    retries: 3
```

Adjust volume paths to match your Directus setup. The sidecar needs access to the same uploads and extensions directories as Directus.

The `backup` service must be on the **same Docker network as Directus** so it can reach `http://directus:8055`. In a single Compose project the default network handles this automatically — only add an explicit `networks:` block if your stack uses a custom network (and make sure the `directus` service is attached to it as well). The sidecar deliberately publishes **no host port**: it is reachable only from within the Docker network, never from outside.

## Step 2 — Install the Extension

**Option A — Directus Marketplace:**

In the Directus Admin App, go to **Settings → Marketplace** and search for `backup` (or the full package name `@alphanull/directus-extension-backup`), then install it. Directus downloads and manages the extension automatically (it lands under `extensions/.registry/<uuid>/`).

> **Note:** This extension ships a **non-sandboxed API endpoint** (the proxy to the sidecar). With the default `MARKETPLACE_TRUST=sandbox`, Directus only allows sandboxed API extensions from the Marketplace, so a Marketplace install requires setting `MARKETPLACE_TRUST=all`. Review the [Directus security best practices](https://directus.io/docs/guides/security/best-practices) before changing this. Directus Cloud does not allow this setting and is therefore not supported.

**Option B — Copy from source:**

```sh
rsync -a --exclude=node_modules --exclude=.DS_Store \
  /path/to/directus-backup/packages/extension/ \
  /path/to/directus/extensions/directus-extension-backup/
```

The `dist/` files are committed, so no build step is needed. This yields a self-contained `extensions/directus-extension-backup/` folder (containing `dist/` and `package.json`) — the layout Directus expects for local extensions.

## Step 3 — Configure Directus

Add these environment variables to your **Directus** service:

```yaml
environment:
  BACKUP_URL: http://backup:4700
  BACKUP_SECRET: ${BACKUP_SECRET}
```

## Step 4 — Set Secrets

Generate the shared secret (required) and, optionally, a Directus token:

```sh
# Shared secret for sidecar authentication (required)
BACKUP_SECRET=$(openssl rand -hex 32)

# Optional: static Directus token for failure notifications + version detection.
# The token's user does NOT need admin rights — only read users/roles + create
# notifications. See "Notifications & Version Detection" in configuration.md.
# Leave it unset to disable both features.
BACKUP_TOKEN=<your-directus-static-token>
```

## Step 5 — Restart

```sh
docker compose up -d
```

## Step 6 — Enable the Module

After restarting, the Backup module needs to be activated in Directus:

1. Go to **Settings → Modules** (or `/settings/modules`)
2. Find **Backup** in the module list
3. Check the checkbox to enable it
4. Save

The module will then appear in the sidebar for all users with access.

## Access Control

By default the Backup module — both the sidebar entry and every `/backup-api/`* route — is available only to **admin users**. To grant access to non-admin users, use a Directus access policy:

1. Go to **Settings → Access Policies** and create a policy named exactly `Backup Access` (the name is matched verbatim).
2. The policy needs **no collection permissions** and no App-Admin Access toggles of its own — the extension only checks that this policy is  *assigned*. The user still needs normal app login via their regular role.
3. Under **Assigned to**, attach the policy to one or more **roles** (every user in the role gets access) and/or directly to individual **users** (per-user access).

Enforcement happens in two places: the module's `preRegisterCheck` (sidebar visibility) and every API route. A non-admin without the policy does not see the module and receives `403 Forbidden` from the API.

To revoke access, remove the policy assignment from the user or role. Admin users always have access and cannot be excluded this way.

## Environment Variables


| Variable                   | Used by           | Default                | Description                                                                                                                                                                                                                       |
| -------------------------- | ----------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_SECRET`            | Directus, Sidecar | —                      | Shared secret for authenticated communication                                                                                                                                                                                     |
| `BACKUP_TOKEN`             | Sidecar           | —                      | Optional. Token for failure notifications + version detection. Needs read `directus_users`/`directus_roles` + create `directus_notifications` (not admin). See [configuration](configuration.md#notifications--version-detection) |
| `ADMIN_EMAIL`              | Sidecar           | —                      | Admin email for failure notifications. Fallback: all Administrator users                                                                                                                                                          |
| `BACKUP_DIR`               | Sidecar           | `/directus/backups`    | Container path to backup storage                                                                                                                                                                                                  |
| `UPLOADS_DIR`              | Sidecar           | `/directus/uploads`    | Container path to Directus uploads                                                                                                                                                                                                |
| `EXTENSIONS_DIR`           | Sidecar           | `/directus/extensions` | Container path to Directus extensions                                                                                                                                                                                             |
| `BACKUP_URL`               | Directus          | —                      | Internal URL of the sidecar (e.g. `http://backup:4700`)                                                                                                                                                                           |
| `DB_ADAPTER`               | Sidecar           | `postgres`             | Database adapter. See [db-adapters.md](db-adapters.md)                                                                                                                                                                            |
| `BACKUP_DUMP_FORMAT`       | Sidecar           | `custom`               | `custom` (compressed) or `plain` (SQL)                                                                                                                                                                                            |
| `BACKUP_IMPORT_ENABLED`    | Sidecar           | `false`                | Secure-by-default OFF. Set to `true`/`1` to allow importing foreign archives. See [Import / Export Controls](configuration.md#import--export-controls)                                                                            |
| `BACKUP_EXPORT_ENABLED`    | Sidecar           | `false`                | Secure-by-default OFF. Set to `true`/`1` to allow downloading backups. See [Import / Export Controls](configuration.md#import--export-controls)                                                                                   |
| `RUNNER_TIMEOUT_MIN`       | Sidecar           | `90`                   | Max minutes a single backup/restore may run before the runner is killed. `0` disables. Raise for very large databases                                                                                                             |
| `DIRECTUS_CONTAINER`       | Sidecar           | `directus`             | Docker container name to stop/start during restore                                                                                                                                                                                |
| `DIRECTUS_URL`             | Sidecar           | `http://directus:8055` | Internal URL of the Directus instance                                                                                                                                                                                             |
| `HOOK_POST_RESTORE_URL`    | Sidecar           | —                      | Post-restore webhook URL (see [Event Hooks](#event-hooks-work-in-progress))                                                                                                                                                       |
| `HOOK_POST_RESTORE_SECRET` | Sidecar           | —                      | Auth secret for post-restore webhook                                                                                                                                                                                              |
| `HOOK_POST_RESTORE_HINT`   | Sidecar           | —                      | Recovery hint for admin notifications                                                                                                                                                                                             |
| `CACHE_HOST`               | Sidecar           | `cache`                | Redis hostname for cache flush after restore. Set to empty (`CACHE_HOST=`) to disable the flush for setups without Redis                                                                                                          |
| `CACHE_PORT`               | Sidecar           | `6379`                 | Redis port                                                                                                                                                                                                                        |
| `CACHE_DB`                 | Sidecar           | `0`                    | Redis database index Directus uses. Only this DB is flushed after restore (`FLUSHDB`), so a shared Redis instance is left intact                                                                                                  |
| `DB_HOST`                  | Sidecar           | `database`             | Database host                                                                                                                                                                                                                     |
| `DB_USER`                  | Sidecar           | —                      | Database user                                                                                                                                                                                                                     |
| `DB_PASSWORD`              | Sidecar           | —                      | Database password                                                                                                                                                                                                                 |
| `DB_DATABASE`              | Sidecar           | —                      | Database name                                                                                                                                                                                                                     |


## Event Hooks (Work in Progress)

The sidecar supports webhook-style event hooks for integration with external systems. Hooks are configured via environment variables following the naming convention `HOOK_<EVENT>_URL`.

### Currently supported


| Event          | Env Variable            | Description                       |
| -------------- | ----------------------- | --------------------------------- |
| `POST_RESTORE` | `HOOK_POST_RESTORE_URL` | Called after a successful restore |


### Hook configuration


| Variable                   | Default | Description                                                                  |
| -------------------------- | ------- | ---------------------------------------------------------------------------- |
| `HOOK_POST_RESTORE_URL`    | —       | Full webhook URL (including path) called via POST after a successful restore |
| `HOOK_POST_RESTORE_SECRET` | —       | Sent as `X-Webhook-Secret` header for authentication                         |
| `HOOK_POST_RESTORE_HINT`   | —       | Recovery hint included in admin notifications when the hook fails            |


### Behavior

- Hooks are **fire-and-forget with error handling**: a failing hook does not affect the restore result.
- The hook target receives a `POST` request with the `X-Webhook-Secret` header (if configured).
- **Response bodies are currently ignored.** Only the HTTP status code is evaluated (2xx = success).
- On failure or timeout (5 min), an in-app notification is sent to admins with the error and the recovery hint.
- If `HOOK_POST_RESTORE_URL` is not set, the hook is silently skipped.

### Planned (not yet implemented)


| Event         | Description               |
| ------------- | ------------------------- |
| `PRE_BACKUP`  | Before a backup starts    |
| `POST_BACKUP` | After a successful backup |
| `PRE_RESTORE` | Before a restore starts   |


### Example

```yaml
backup:
  environment:
    HOOK_POST_RESTORE_URL: http://sync:4500/sync/full
    HOOK_POST_RESTORE_SECRET: ${WEBHOOK_SECRET}
    HOOK_POST_RESTORE_HINT: "docker compose exec sync npm run cms:sync"
```

## External Restore (Disaster Recovery)

Restores can be triggered without the Directus Studio UI. The sidecar exposes a `POST /restore` endpoint (secured by `X-Backup-Secret`); both options below use it.

**Option A — `restore.sh` (host-side helper).** This script runs on the Docker **host**, not inside the container: it needs the host's `docker` CLI and reads the backups directory directly to list available backups. It ships with the source repository, not with the published image.

```sh
# Interactive — pick from a list
BACKUP_DIR=./backups CONTAINER=<backup-container> ./packages/sidecar/restore.sh

# Non-interactive
BACKUP_DIR=./backups CONTAINER=<backup-container> \
  ./packages/sidecar/restore.sh 2026-02-20__14-30-00__pre-deploy
```

**Option B — direct API call (image only).** If you run the published image without the repository checked out, trigger the endpoint from inside the running sidecar container (`BACKUP_SECRET` is already present there as an environment variable):

```sh
docker exec <backup-container> sh -c 'wget -qO- \
  --header="X-Backup-Secret: $BACKUP_SECRET" \
  --header="Content-Type: application/json" \
  --post-data="{\"backupId\":\"2026-02-20__14-30-00__pre-deploy\"}" \
  http://127.0.0.1:4700/restore'
```

The restore process connects to a running database instance. If the database data directory was wiped, start the database container first (it will auto-initialize), then run the restore.

### If a restore fails midway

A restore is performed **in-place**: the database schema is reset before the backup is loaded. Dump integrity is checksum-verified before that happens, so a corrupt backup is rejected without touching the live database. However, once the schema reset has run, a later failure (e.g. disk full, lost connection) can leave the database in a partial state that needs manual recovery:

- The backup is the source of truth — fix the underlying cause and re-run the restore. It is safe to retry.
- The runner writes the reason to `restore-error.txt` inside the backup directory, and the full log to `runner.log`.

