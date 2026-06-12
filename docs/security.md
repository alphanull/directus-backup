# Security

This document consolidates the security-relevant information for the standalone backup extension. It covers the measures in place and explicitly warns about the risk profile of specific settings.

> **How this differs from the sidecar design.** The original architecture used a separate sidecar container that required the **Docker socket** and a **shared secret** (`BACKUP_SECRET`) over an internal HTTP port. The standalone extension removes both: it runs inside Directus, authorizes through Directus itself, and performs restores via a container restart instead of a privileged Docker connection. The Docker-socket and network-port attack surfaces described in the old docs **no longer exist**.

## Trust Model

There is a single component: the extension (UI module + API endpoint + shell scripts) running inside the Directus process. It is the enforcement point for every backup operation.

| Concern             | Where it lives                       | Enforcement                                                           |
| ------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| User authorization  | API endpoint (in Directus)           | Directus accountability + `Backup Access` policy check on every route |
| Import/export gates | API endpoint                         | `BACKUP_IMPORT_ENABLED` / `BACKUP_EXPORT_ENABLED` env flags           |
| Archive validation  | API endpoint                         | Structural + scope/quota checks before extraction                     |
| Backup/restore work | `backup.sh` / `restore.sh` + adapter | Runs as the unprivileged `node` user inside the container             |

**Consequence:** the UI hiding a button is a UX convenience, not a security boundary — every `/backup-api/`* route re-checks authorization and the import/export flags server-side.

## No Docker Socket, No Shared Secret

- **No Docker socket.** The extension never mounts or talks to `/var/run/docker.sock`. Restores are performed by writing a flag file to the backup volume and letting the container's `restart: unless-stopped` policy restart it; the restore then runs from the entrypoint on the clean boot. There is no privileged, root-equivalent socket access anywhere in the deployment.
- **No shared secret / no exposed port.** Because nothing runs outside Directus, there is no internal HTTP service to authenticate against and no extra port to keep unpublished. The only network surface is the normal Directus HTTP API.

## Marketplace Trust

The API endpoint uses **direct database access** for authorization and **spawns a child process** (`backup.sh`) for backups. Both are operations a sandboxed extension may not perform, so the endpoint is **not sandboxed**.

> ‼️ **WARNING:** A Marketplace install therefore requires `MARKETPLACE_TRUST=all` on self-hosted instances. This setting relaxes Directus's restriction that only sandboxed API extensions may be installed from the Marketplace — review the [Directus security best practices](https://directus.io/docs/guides/security/best-practices) before enabling it. Directus Cloud does not allow this setting and is not supported.

Installing from source (copying the extension folder) does not require `MARKETPLACE_TRUST=all`.

## Authentication & Authorization

Every `/backup-api/`* route requires the requesting user to be either:

- A Directus **admin**, or
- Assigned the `Backup Access` access policy (exact name match, case-sensitive).

This is enforced on **every request** via a parameterized database query over `directus_policies` and `directus_access`, using the request's Directus accountability. The module's `preRegisterCheck` additionally controls sidebar visibility.

> ⚠️ **Note:** Admin users always have access and cannot be restricted via the policy mechanism. To revoke access for non-admins, remove the `Backup Access` policy from their role or user record.

The `Backup Access` policy itself requires no collection permissions and no App/Admin Access toggles — it is a named marker the extension only checks for assignment.

### Access policy scope

The `Backup Access` policy grants access to **all** backup operations: create, restore, delete, cancel, and — when enabled — import and export. There is currently no read-only or create-only level for non-admins. A holder of the policy can:

- Create, cancel, and delete backups
- Restore any backup (full or partial, potentially dropping the live schema)
- If import is enabled: upload arbitrary archives
- If export is enabled: download any backup (full database + assets)

Assign the policy only to users who need full operational control of the backup system.

## Import & Export Controls

> ‼️ **WARNING:** Import and Export are the two operations that move backup archives across the trust boundary. Both are **disabled by default** and must be explicitly enabled. Enabling either materially changes the risk profile of the deployment.

Both controls are **environment variables on the Directus service** — not part of `backup-config.json`. A user holding only the `Backup Access` policy cannot enable them through the UI or the config API.

| Variable                | Default | Effect when enabled                                                   |
| ----------------------- | ------- | --------------------------------------------------------------------- |
| `BACKUP_IMPORT_ENABLED` | `false` | Allows uploading foreign `.tar.gz` archives into the backup directory |
| `BACKUP_EXPORT_ENABLED` | `false` | Allows downloading any backup as a full `.tar.gz` archive             |

Enable only with the exact value `true` or `1`:

```yaml
BACKUP_IMPORT_ENABLED: "true"
BACKUP_EXPORT_ENABLED: "true"
```

### What enabling import means

Any authenticated user (admin or `Backup Access` holder) can upload a `.tar.gz` archive that is extracted into the backup directory and made available for restore.

**Risk:** an authenticated but malicious or compromised user can stage a crafted archive — a manipulated database dump, different data, altered system records — and then restore it. The extension performs [archive validation](#archive-upload-validation) but cannot verify the semantic correctness of the dump contents.

**Recommendation:** only enable import when you need to transfer backups between environments; do not leave it on permanently. Restrict who holds the `Backup Access` policy while import is active.

### What enabling export means

Any authenticated user can download any backup as a full `.tar.gz` archive containing the complete database dump (all user data, credential hashes, API tokens, secrets stored in Directus), all uploaded assets, and optionally all extensions.

**Risk:** this is a **bulk data exfiltration path** — a single download exposes the entire Directus database.

**Recommendation:** only enable export when you need to move a backup off the server, and disable it again immediately after.

## Archive Upload Validation

When import is enabled, uploaded archives are validated **before extraction**:

| Check                  | What is rejected                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Symlinks               | Archives containing symbolic links                                                                                      |
| Hard links             | Archives containing hard links                                                                                          |
| Device / special files | Block devices, character devices, pipes, sockets                                                                        |
| Path traversal         | Paths starting with `/` or containing `..`                                                                              |
| ID structure           | Archives without exactly one top-level directory matching the backup ID regex (`YYYY-MM-DD__HH-MM-SS__<label>`)         |
| Duplicate              | A backup with the same ID already exists (409 Conflict)                                                                 |
| Manifest presence      | Archive has no `backup.json`                                                                                            |
| Manifest status        | `backup.json` does not have `status: "success"`                                                                         |
| Manifest ID match      | `backup.json` declares a different ID than the directory name                                                           |
| Scope consistency      | Manifest declares a component whose file is not physically present in the archive                                       |
| Collection names       | Manifest `scope.includedCollections` contains a name that is not a strict collection identifier (`[A-Za-z0-9_-]{1,64}`) |
| Pre-extraction quota   | Estimated compressed size would already exceed `quotaMB`                                                                |
| Post-extraction quota  | Actual extracted size exceeds `quotaMB`                                                                                 |

> **Limitation:** archive validation cannot verify the semantic integrity of the database dump. A dump that passes all structural checks could contain arbitrary SQL or manipulated data. Treat imported backups from untrusted sources as untrusted.

### Upload size

Directus's `MAX_PAYLOAD_SIZE` does **not** limit import upload size: the upload uses `Content-Type: application/gzip`, which bypasses the Directus `express.json()` middleware that enforces that limit. Verified end-to-end in the integration test (`test/integration/run.sh`) against Directus 11.17.4 with `MAX_PAYLOAD_SIZE=1mb`: a ~2 MB `application/gzip` archive is accepted (HTTP 200) while the same bytes sent as `application/json` are rejected. The effective size guard on the import path is the `minFreeMB` free-space check (HTTP 507 when the volume would drop below the configured minimum). Verify `minFreeMB` and `quotaMB` are appropriate for your storage before enabling import.

## Restore Risks

### In-place schema reset

A full database restore performs `DROP SCHEMA public CASCADE` before loading the dump. Validation runs **before** that point of no return (see below), so a corrupt backup is rejected before the live database is touched. However, once the schema drop has executed, a later failure (e.g. disk full, lost connection) can leave the database in a partial state.

> ‼️ **WARNING:** a partial restore cannot be undone by retrying the same failed run — it requires a complete re-run of the restore from the beginning. `restore.sh` writes the reason to `restore-error.txt` inside the backup directory, and its full output goes to the Directus container logs.

**Safe retry:** it is always safe to re-run a restore from a known-good backup after fixing the underlying cause.

### Pre-restore validation (before the point of no return)

**API path (normal restore via Directus Studio):** the extension validates the backup *while Directus is still up*, before arming the restart:

1. Manifest `status` is `success`.
2. SHA-256 checksums match `checksums.sha256` (guards against on-disk corruption). A legacy backup without checksums logs a warning and is allowed through.
3. For custom-format dumps, `pg_restore --list` exits 0 (guards against an unreadable/truncated dump).
4. The database is reachable (`SELECT 1`).

Only if all pass does the extension write the `.pending_restore` flag and restart the container.

`**recover.sh` path (disaster recovery):** there is no pre-arm validation — Directus is not running so checks 1 and 4 are not possible. `recover.sh` only verifies that the backup directory and its component files exist before writing the flag. Checks 2 and 3 still run at boot time inside `restore.sh`, before any destructive operation, for both paths.

### Crash loop guard

`restore.sh` claims the flag by renaming it to `.restore_processing` before running. If a boot crashes mid-restore, the next boot finds the leftover `.restore_processing`, refuses to re-run (the DB may be partially restored), and marks the run failed for the extension to report. This prevents an endless restore/crash loop.

### Runner timeout (bounded boot)

The boot-time restore runs without an external supervisor, so a hung `pg_restore`/`psql`/`tar` would otherwise block the container boot indefinitely *and* keep mutating the database while Directus starts. `restore.sh` therefore runs the restore body under a wall-clock watchdog (`RUNNER_TIMEOUT_MIN`, default 90; `0` disables). On timeout it terminates the **entire restore process group** (SIGTERM, then SIGKILL after a 10 s grace), so no orphaned database process survives, then marks the run failed with a clear reason. The group kill relies on `setsid` (present in the standard image's BusyBox); if `setsid` is unavailable while the timeout is enabled, restore readiness fails and `restore.sh` aborts before running the restore body. Set `RUNNER_TIMEOUT_MIN=0` only if you intentionally accept an unbounded boot-time restore.

### Partial (targeted) restore

A targeted restore (specific collections selected) does **not** drop the schema — it only replaces the selected tables' data; everything else is untouched. The restored data must be compatible with the current schema; restoring into a schema that has diverged from the backup may produce constraint violations or silently inconsistent data.

### Checksums

SHA-256 checksums are verified before any restore begins. A mismatch is a hard failure that aborts the restore — the database is not touched. Row-count verification *after* a restore is non-fatal: mismatches set `restoreVerify.status: "warn"` in the manifest but the restore is considered complete.

## Disaster Recovery CLI

`scripts/recover.sh` is a host-side tool for recovering when Directus Studio is unavailable or Directus will not boot at all. It writes the `.pending_restore` flag into the backup volume — via a throwaway helper container that mounts the same volumes (`docker run --rm --volumes-from <directus> alpine`) — and restarts the Directus container; the restore then runs on the next boot.

**Security implications:**

- It requires **Docker access on the host**. Anyone who can run `docker` on the host can already control every container and is effectively root-equivalent — so this tool grants no privilege that host access does not already imply.
- It bypasses the Directus authorization layer (there is no running Directus to authorize against), which is the intended behavior for disaster recovery. Protect host/Docker access accordingly.
- It does **not** weaken the runtime: the restore still runs through `restore.sh`, which verifies SHA-256 checksums before touching the database, and the restore scope is derived from the artefacts actually present in the archive.

## Secrets & Credentials

- **Database credentials** (`DB_USER`, `DB_PASSWORD`, `DB_DATABASE`) are the standard Directus variables, reused by the extension to run dumps and restores. They have the same sensitivity as direct database access.
- `**HOOK_POST_RESTORE_URL`** — if configured, the Directus container sends an outbound `POST` after a successful restore. The URL is operator-controlled environment configuration, so changing it already requires privileged deployment access; still, operate it as an outbound network capability and restrict container egress if internal services or metadata endpoints must not be reachable.
- `**HOOK_POST_RESTORE_SECRET**` — if the post-restore webhook is configured, this secret is sent as the `X-Webhook-Secret` header. Keep it in the environment, not hardcoded, and rotate it if the hook endpoint changes or is exposed.

The standalone extension has **no** `BACKUP_SECRET` or `BACKUP_TOKEN` to manage.

## Summary: Settings with Security Consequences

| Setting                           | Default     | Risk when changed                                                                                 |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `BACKUP_IMPORT_ENABLED`           | `false`     | Enables upload of foreign archives; allows staging a malicious backup for restore                 |
| `BACKUP_EXPORT_ENABLED`           | `false`     | Enables full backup download; bulk data exfiltration path                                         |
| `MARKETPLACE_TRUST=all`           | `sandbox`   | Required to install this (non-sandboxed) extension from the Marketplace; relaxes a Directus guard |
| `Backup Access` policy assignment | admins only | Grants full backup control (including restore) to non-admin users                                 |
| `CACHE_HOST=` (empty)             | `cache`     | Disables Redis flush after restore; Directus may serve stale data from cache post-restore         |
| `HOOK_POST_RESTORE_URL`           | unset       | Enables an outbound POST from the Directus container after restore                                |
