# Installation

This extension runs **entirely inside the Directus container** — there is no sidecar service and no Docker socket access. Setup is: update the Directus service in Compose, add the Dockerfile it builds from, install the extension, enable the module.

> **Ready-to-use files.** The `[examples/](../examples/)` directory contains a complete, working stack (`docker-compose.yml`, `Dockerfile`, `.env.example`) plus a snippet for adding the extension to an existing Directus stack (`docker-compose.addon.yml`). The `Dockerfile` embeds the boot-time entrypoint stub, so it is self-contained; `entrypoint.sh` is only needed for the no-BuildKit variant below. The steps below explain each piece; copy from `examples/` to skip the typing.

## Prerequisites

- Docker and Docker Compose
- A running Directus instance (v11+)
- PostgreSQL (the only supported database adapter in this release)
- `MARKETPLACE_TRUST=all` for a Marketplace install (the API endpoint is **not sandboxed**; see [security.md](security.md#marketplace-trust)). Directus Cloud does not allow this and is not supported.

## Step 1 — Configure the Directus service

Open the `docker-compose.yml` (or `compose.yaml`) that starts Directus and find your existing `directus:` service. Replace the stock `image: directus/directus:...` line with `build: .`, then add the **restart policy** (required — it is what brings the container back after a restore) and mount a **backup volume**.

`build: .` means Compose will build a `Dockerfile` from the same folder as your Compose file. You will add that `Dockerfile` in step 2; do not start the stack until both steps are done. The extension reuses Directus's own database and cache settings, so no extra DB credentials are needed.

```yaml
directus:
  build: .                 # builds the Dockerfile from step 2
  restart: unless-stopped  # REQUIRED — the restore restarts the container
  volumes:
    - ./uploads:/directus/uploads
    - ./extensions:/directus/extensions
    - backups:/directus/backups   # backup storage (BACKUP_DIR)
  environment:
    # Reused by the extension — typically already present on your Directus service:
    DB_CLIENT: pg
    DB_HOST: database
    DB_DATABASE: ${DB_DATABASE}
    DB_USER: ${DB_USER}
    DB_PASSWORD: ${DB_PASSWORD}
    # Optional — enable upload/download of backup archives (off by default):
    BACKUP_IMPORT_ENABLED: "true"
    BACKUP_EXPORT_ENABLED: "true"

volumes:
  backups:
```

> ⚠️ **NOTE** The `backups:` named volume shown above does not require a host directory. If you use a bind mount instead (for example `./backups:/directus/backups`), the host directory must be writable by uid 1000.

> ⚠️ **NOTE** Backups run inside the Directus container and share its CPU/RAM limits. If your `directus:` service has explicit CPU or memory limits in Compose, remember that backups share those limits. In this case, as a practical starting point, give the Directus service about **one additional CPU** if backups run during normal traffic. If scheduled for quiet hours, less may be enough. Run one representative backup in staging and adjust CPU/RAM or the schedule if Directus latency becomes noticeable.

## Step 2 — Add the Dockerfile

The stock Directus image has no Dockerfile and does not ship `pg_dump`/`pg_restore`, and the restore must run on a clean boot **before** Directus starts (see [architecture.md](architecture.md#restore-data-flow)). Therefore, first check whether there is already a `Dockerfile` next to the Compose file from step 1.

### Case A: no existing Dockerfile

The Dockerfile provided in the examples covers both — the boot-time entrypoint stub is embedded via a heredoc, so no second file is needed. Copy `[examples/Dockerfile](../examples/Dockerfile)` into that folder, or create the file from the snippet below. If your Compose file used a different Directus image tag, update the `FROM directus/directus:...` line to the same Directus version.

### Case B: existing Dockerfile

Do not replace an existing `Dockerfile` blindly. Merge the required parts into it instead:

- install the PostgreSQL client while the Dockerfile is still running as `root`;
- add the restore entrypoint logic so it runs before Directus starts;
- keep or add `RUN mkdir -p /directus/backups && chown node:node /directus/backups`;
- preserve any existing custom build steps;
- check existing `ENTRYPOINT` and `CMD` instructions, because the last one wins.

If the existing Dockerfile already has a custom entrypoint, merge the restore logic into that entrypoint before the final Directus start command instead of adding a second competing entrypoint.

The stock Directus image does not ship `pg_dump`/`pg_restore`, and the restore must run on a clean boot **before** Directus starts (see [architecture.md](architecture.md#restore-data-flow)). The Dockerfile below covers both — the boot-time entrypoint stub is embedded via a heredoc, so no second file is needed:

```dockerfile
FROM directus/directus:11.17.4

USER root

# pg_dump / pg_restore / psql for the PostgreSQL adapter (~5 MB).
RUN corepack enable && apk add --no-cache postgresql16-client

# Boot-time restore stub: runs a pending restore on a clean boot, before
# Directus starts. Generic — it only locates and runs the extension's
# restore.sh when a restore is pending; without the extension it is a no-op
# pass-through. The quoted 'EOF' keeps ${...} literal (expanded at container
# runtime, not at build time).
COPY --chmod=755 <<'EOF' /entrypoint.sh
#!/bin/sh
BACKUP_DIR="${BACKUP_DIR:-/directus/backups}"
EXTENSIONS_DIR="${EXTENSIONS_DIR:-${EXTENSIONS_PATH:-/directus/extensions}}"

if [ -f "$BACKUP_DIR/.pending_restore" ] || [ -f "$BACKUP_DIR/.restore_processing" ]; then
  for f in "$EXTENSIONS_DIR"/.registry/*/scripts/restore.sh "$EXTENSIONS_DIR"/*/scripts/restore.sh; do
    if [ -f "$f" ]; then
      BACKUP_DIR="$BACKUP_DIR" sh "$f" || true
      break
    fi
  done
fi

exec docker-entrypoint.sh "$@"
EOF

# The backup directory must be writable by the unprivileged `node` user (uid 1000).
# Creating it here (owned by node) makes a fresh *named volume* mounted over it
# inherit that ownership — exactly how /directus/uploads already works.
RUN mkdir -p /directus/backups && chown node:node /directus/backups

USER node

ENTRYPOINT ["/entrypoint.sh"]
# Overriding ENTRYPOINT resets the inherited CMD, so re-declare the stock Directus
# start command. The value below matches Directus 11.x; if your base image changes
# it, copy the current one.
CMD ["/bin/sh", "-c", ": && node cli.js bootstrap && pm2-runtime start ecosystem.config.cjs ;"]
```

> ⚠️ **NOTE** The `COPY <<'EOF'` heredoc requires **BuildKit** — the default builder since Docker 23 and in Docker Compose v2 (also supported by Buildah/Podman >= 1.33). `docker compose up --build` on any current Docker installation just works.

### Alternative: separate `entrypoint.sh` (no BuildKit required)

For build environments without heredoc support (legacy `docker build`, Docker < 23), keep the stub as its own file instead: copy `[examples/entrypoint.sh](../examples/entrypoint.sh)` next to the `Dockerfile` and replace the heredoc block above with a classic `COPY`:

```dockerfile
# Run a pending restore on a clean boot, before Directus starts.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
```

Both variants produce an identical `/entrypoint.sh`; the extension's installation health check accepts either.

Once the stack is rebuilt and the extension is installed, open the Backup module in Directus Studio. If any required setup is missing (PostgreSQL client binaries, entrypoint stub, writable backup volume, etc.), a red banner lists the problems and backups/restores stay disabled until they are fixed. The same checks are exposed at `GET /backup-api/health` for automation.

## Step 3 — Install the extension

**Option A — Directus Marketplace:**

In **Settings → Marketplace**, search for `backup` (or the full package name `@alphanull/directus-extension-backup`) and install it. Directus downloads and manages the extension automatically (it lands under `extensions/.registry/<uuid>/`).

> ‼️ **IMPORTANT** The extension ships a **non-sandboxed API endpoint** (it uses direct database access for authorization and spawns a child process for backups). With the default `MARKETPLACE_TRUST=sandbox`, Directus blocks it — a Marketplace install requires `MARKETPLACE_TRUST=all`. Review the [Directus security best practices](https://directus.io/docs/guides/security/best-practices) before changing this.

**Option B — Copy from source:**

Copy the package contents — the `dist/` directory, `scripts/`, and `package.json` — into your Directus extensions folder as `extensions/directus-extension-backup/`:

```sh
rsync -a --exclude=node_modules --exclude=.DS_Store \
  /path/to/directus-extension-backup/ \
  /path/to/directus/extensions/directus-extension-backup/
```

The `scripts/` directory (which contains `backup.sh`, `restore.sh`, `recover.sh`, and the adapters) **must** be included — the entrypoint from Step 2 looks it up there.

## Step 4 — Build and start

```sh
docker compose up -d --build
```

## Step 5 — Enable the module

After starting, the Backup module must be activated in Directus:

1. Go to **Settings → Modules** (or `/settings/modules`)
2. Find **Backup** in the module list
3. Enable it and save

The module then appears in the sidebar for admin users and users assigned the `Backup Access` policy.

## Access Control

By default the Backup module — both the sidebar entry and every `/backup-api/`* route — is available only to **admin users**. To grant access to non-admin users, use a Directus access policy:

1. Go to **Settings → Access Policies** and create a policy named exactly `Backup Access` (the name is matched verbatim, case-sensitive).
2. The policy needs **no collection permissions** and no App/Admin Access toggles of its own — the extension only checks that this policy is *assigned*. The user still needs normal app login via their regular role.
3. Under **Assigned to**, attach the policy to one or more **roles** and/or directly to individual **users**.

Enforcement happens in two places: the module's `preRegisterCheck` (sidebar visibility) and every API route (a parameterized query over `directus_policies` / `directus_access`). A non-admin without the policy does not see the module and receives `403 Forbidden` from the API. Admin users always have access and cannot be excluded this way.

See [security.md](security.md#authentication--authorization) for the full authorization reference.

## Environment Variables

All variables are set on the **Directus service**. Database and cache settings are the standard Directus variables and are reused automatically.

| Variable                                                          | Default                | Description                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `BACKUP_DIR`                                                      | `/directus/backups`    | Backup storage directory (must be writable by uid 1000)                                                                              |
| `UPLOADS_DIR`                                                     | `/directus/uploads`    | Directus uploads directory (backed up as assets)                                                                                     |
| `EXTENSIONS_DIR`                                                  | `/directus/extensions` | Directus extensions directory                                                                                                        |
| `DB_CLIENT` / `DB_ADAPTER`                                        | `pg` → `postgres`      | Selects the DB adapter. Directus's `pg` maps to `postgres`; only `postgres` is supported in this release                             |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | Directus values        | Database connection — reused from Directus                                                                                           |
| `BACKUP_IMPORT_ENABLED`                                           | `false`                | Allow uploading/importing foreign archives. See [security.md](security.md#import--export-controls)                                   |
| `BACKUP_EXPORT_ENABLED`                                           | `false`                | Allow downloading backups. See [security.md](security.md#import--export-controls)                                                    |
| `RUNNER_TIMEOUT_MIN`                                              | `90`                   | Max minutes a single backup/restore may run before the runner is killed. Restore timeout enforcement requires `setsid`; `0` disables |
| `ADMIN_EMAIL`                                                     | —                      | Recipient for in-app failure notifications. Fallback: all users with the `Administrator` role                                        |
| `CACHE_HOST` / `CACHE_PORT` / `CACHE_DB`                          | `cache` / `6379` / `0` | Redis used for the post-restore cache flush. Set `CACHE_HOST=` (empty) to disable for setups without Redis                           |
| `HOOK_POST_RESTORE_URL` / `_SECRET` / `_HINT`                     | —                      | Optional webhook fired after a successful restore                                                                                    |

## Disaster recovery

When Directus Studio is unavailable — or Directus will not boot at all because the database is corrupt or destroyed — arm a restore from the host with `scripts/recover.sh`. It does **not** need a running Directus or its API: it writes the restore flag into the backup volume (via a throwaway helper container that mounts the same volumes with `--volumes-from`) and restarts the Directus container. The boot-time runner `scripts/restore.sh` then performs the restore on the next boot, *before* Directus starts.

```sh
# Interactive picker — lists available backups:
CONTAINER=<your-directus-container> ./scripts/recover.sh

# Or restore a specific backup directly:
CONTAINER=<your-directus-container> ./scripts/recover.sh 2026-02-20__14-30-00__manual
```

Works whether the Directus container is running, stopped, or crash-looping; it only needs the Docker CLI and an existing container (the backup volume is read through it). The restore scope is derived from the artefacts actually present in the archive, and `restore.sh` verifies the SHA-256 checksums before touching the database.

Monitor progress with `docker logs -f <container>` while the restore runs.