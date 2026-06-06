# Security

This document consolidates all security-relevant information for the Directus Backup system. It covers the measures already in place and explicitly warns about the risk profile of specific settings and configurations.

## Trust Model

The system has two components with distinct trust levels:


| Component                                  | Trust level   | Enforcement                                                                                                                         |
| ------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Sidecar**                                | Authoritative | Enforces all security controls — secret check, import/export gates, archive validation, path validation                             |
| **Directus extension** (API endpoint + UI) | Delegation    | Authenticates users, forwards requests to the sidecar; honors import/export flags from the sidecar but does **not** re-enforce them |


**Consequence:** bypassing the UI or the Directus endpoint does not bypass security controls. The sidecar is the single enforcement point for all operations that matter. The UI hiding a button is a UX convenience, not a security boundary.

## Docker Socket Access

The sidecar requires the Docker socket to stop and restart the Directus container during a restore:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

> **Warning:** Docker socket access is **root-equivalent** on the host. The `:ro` mount flag applies only to the socket file node — it does **not** restrict what Docker API operations (container stop, start, inspect, exec) can be performed through the socket. A process with access to the Docker socket can stop, modify, or escape any container on the host.

**Consequence:** treat the sidecar as a **privileged component**:

- Keep it on an internal-only network (see [Network Security](#network-security))
- Protect `BACKUP_SECRET` with the same care as root credentials
- Do not expose the sidecar's HTTP port

## Network Security

### Sidecar port exposure

> **Warning:** The sidecar listens on all interfaces (`0.0.0.0:4700`). `BACKUP_SECRET` is the **only** protection. If this port is reachable from outside the internal Docker network, the entire backup system — including all backup data and the restore endpoint — is accessible to anyone who obtains or brute-forces the secret.

**Required:** bind the sidecar to an internal-only Docker network. Do **not** publish port 4700 to the host or the internet.

```yaml
networks:
  - internal  # sidecar must be on an internal-only network
```

Never publish the port:

```yaml
# DO NOT do this:
ports:
  - "4700:4700"
```

## Authentication & Authorization

### User access (Directus layer)

Every `/backup-api/*` route requires the requesting user to be either:

- A Directus **admin**, or
- Assigned the `Backup Access` access policy (exact name match, case-sensitive).

This is enforced by the Directus extension on every request, via a parameterized database query over `directus_policies` and `directus_access`. The module's `preRegisterCheck` additionally controls sidebar visibility.

> **Note:** Admin users always have access and cannot be restricted via the policy mechanism. To revoke access for non-admins, remove the `Backup Access` policy from their role or user record.

The `Backup Access` policy itself requires no collection permissions and no App/Admin Access toggles. It is a named marker — the extension only checks that it is assigned.

### Sidecar authentication

Every sidecar route — except `GET /health` — requires the `X-Backup-Secret` header to match the configured `BACKUP_SECRET`. The check uses a **constant-time SHA-256 digest comparison** (`timingSafeEqual`) so neither the secret's value nor its length can be inferred from timing. The secret is never logged.

`GET /health` is intentionally unauthenticated so container health checks can probe it. It returns only `{ "status": "ok" }` and leaks no lock state or backup IDs.

### Access Policy Scope

The `Backup Access` policy grants access to **all** backup operations: create, restore, delete, and — when enabled — import and export. There is currently no way to grant read-only or create-only access to non-admin users. If you assign the policy to a user or role, that user can:

- Create and delete backups
- Restore any backup (full or partial, potentially dropping the live schema)
- If import is enabled: upload arbitrary archives
- If export is enabled: download any backup

Assign the policy only to users who need full operational control of the backup system.

## Import & Export Controls

> **Warning:** Import and Export are the two operations that move backup archives across the trust boundary. Both are **disabled by default** and must be explicitly enabled. Enabling either one materially changes the risk profile of the deployment.

Both controls are environment variables on the **sidecar** — not part of `backup-config.json`. A user holding only the `Backup Access` policy cannot enable them through the UI or the config API.


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

When `BACKUP_IMPORT_ENABLED=true`, any authenticated user (admin or `Backup Access` policy holder) can upload a `.tar.gz` archive that will be extracted into the backup directory and made available for restore.

**Risk:** an authenticated but malicious or compromised user can stage a crafted backup archive — containing a manipulated database dump, different data, or altered system records — and then restore it. The sidecar performs [archive validation](#archive-upload-validation) but cannot verify the semantic correctness of the database dump contents.

**Recommendation:** only enable import if you have an operational need to transfer backups between environments. Do not enable it permanently. Consider restricting which users hold the `Backup Access` policy when import is active.

### What enabling export means

When `BACKUP_EXPORT_ENABLED=true`, any authenticated user can download any backup as a full `.tar.gz` archive. A full backup contains:

- The complete database dump (including all user data, credentials hashes, API tokens, and secrets stored in Directus)
- All uploaded assets
- Optionally: all extensions (if backed up with that scope)

**Risk:** this is a **bulk data exfiltration path**. A single download exposes the entire Directus database. If Directus stores sensitive data (personal data, API keys, payment references, etc.) a single download provides all of it.

**Recommendation:** only enable export when you need to transfer a backup off the server (e.g. to a staging environment or for archival). Disable it again immediately after. Never enable it as a permanent setting in production unless access to the `Backup Access` policy is tightly controlled.

## Archive Upload Validation

When import is enabled, uploaded archives are validated by the sidecar **before extraction**:


| Check                  | What is rejected                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Symlinks               | Archives containing symbolic links                                                                                     |
| Device / special files | Block devices, character devices, pipes, sockets                                                                       |
| Path traversal         | Paths starting with `/` or containing `..`                                                                             |
| ID structure           | Archives without exactly one top-level directory matching the backup ID regex (`YYYY-MM-DD__HH-MM-SS__<label>`)        |
| Duplicate              | A backup with the same ID already exists (409 Conflict)                                                                |
| Manifest presence      | Archive has no `backup.json`                                                                                           |
| Manifest status        | `backup.json` does not have `status: "success"`                                                                        |
| Manifest ID match      | `backup.json` declares a different ID than the directory name                                                          |
| Scope consistency      | Manifest declares a component (`database`, `assets`, `extensions`) whose file is not physically present in the archive |
| Pre-extraction quota   | Estimated size of the compressed archive would already exceed `quotaMB`                                                |
| Post-extraction quota  | Actual extracted size exceeds `quotaMB`                                                                                |


> **Limitation:** archive validation cannot verify the semantic integrity of the database dump. A dump that passes all structural checks could contain arbitrary SQL or manipulated data. Treat imported backups from untrusted sources as untrusted data.

### Upload size

Directus's `MAX_PAYLOAD_SIZE` does **not** limit import upload size. The import uses `Content-Type: application/gzip`, which bypasses the Directus `express.json()` middleware that enforces that limit. The only effective guard is the sidecar's `minFreeMB` free-space check (HTTP 507 when the volume would drop below the configured minimum).

If you enable import, verify that your `minFreeMB` and `quotaMB` settings are appropriate for your storage capacity.

## Secrets & Credentials

### BACKUP_SECRET

The shared secret between Directus and the sidecar. It protects every sidecar route (except `/health`).

**Requirements:**

- Must be a strong, randomly generated value
- Must be kept out of version control
- Must be stored as an environment variable (use `.env` file excluded via `.gitignore`, or a secrets manager)

Generate with:

```sh
BACKUP_SECRET=$(openssl rand -hex 32)
```

### DB credentials

The sidecar holds the database credentials (`DB_USER`, `DB_PASSWORD`, `DB_DATABASE`) to perform dumps and restores. These have the same sensitivity as direct database access.

### BACKUP_TOKEN

An **optional** static Directus access token for failure notifications and version detection. If set:

- The token's user does **not** need admin rights
- Required permissions: read `directus_users`, read `directus_roles`, create `directus_notifications`
- The token does not grant access to the backup system itself

If `BACKUP_TOKEN` is not set, notifications and version detection are silently skipped. The backup and restore process is unaffected.

### HOOK_POST_RESTORE_SECRET

If the post-restore webhook is configured, the secret is sent as `X-Webhook-Secret`. Keep it in the environment, not hardcoded.

## Restore Risks

### In-place schema reset

A full database restore performs `DROP SCHEMA public CASCADE` before loading the backup dump. Checksum verification runs **before** the schema drop — a corrupt backup is rejected before the live database is touched. However, once the schema drop has executed, a subsequent failure (e.g. disk full, lost connection) can leave the database in a partial state.

> **Warning:** a partial restore cannot be undone by retrying — it requires a complete re-run of the restore from the beginning. The runner writes the failure reason to `restore-error.txt` and the full log to `runner.log` inside the backup directory.

**Safe retry:** it is always safe to re-run a restore from a known-good backup after fixing the underlying cause.

### Partial (targeted) restore

A targeted restore (specific collections selected) does **not** drop the schema. It only replaces the selected tables' data. Everything else is left untouched. This carries a different risk: the restored data must be compatible with the current schema. Restoring to a schema that has diverged from the backup's schema may produce constraint violations or silently inconsistent data.

### Checksums

SHA-256 checksums are verified before any restore begins. A checksum mismatch immediately aborts the restore — the database is not touched. This is a hard failure, not a warning.

Row-count verification after a restore is **non-fatal**: mismatches produce a `restoreVerify.status: "warn"` in the manifest but the restore is considered complete.

## Dump Format


| `BACKUP_DUMP_FORMAT` | Format                                     | Implications                                                                |
| -------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `custom` (default)   | Compressed binary PostgreSQL custom format | Not human-readable; requires `pg_restore` to inspect or apply; smaller size |
| `plain`              | Plain SQL text                             | Human-readable SQL; can be inspected with any text editor; larger size      |


> **Note on plain format:** a plain SQL dump is a text file containing all your data as INSERT statements. If export is enabled, a plain-format backup download is a directly readable copy of your entire database. Consider this when choosing the dump format, especially in combination with `BACKUP_EXPORT_ENABLED`.

## Summary: Settings with Security Consequences


| Setting                           | Default       | Risk when changed                                                                         |
| --------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `BACKUP_IMPORT_ENABLED`           | `false`       | Enables upload of foreign archives; allows staging a malicious backup for restore         |
| `BACKUP_EXPORT_ENABLED`           | `false`       | Enables full backup download; bulk data exfiltration path                                 |
| `BACKUP_SECRET`                   | — (required)  | Weak or reused secret weakens the only sidecar authentication layer                       |
| Sidecar port published to host    | not published | Exposes the entire backup API and data to the network                                     |
| `Backup Access` policy assignment | admins only   | Grants full backup control (including restore) to non-admin users                         |
| `BACKUP_DUMP_FORMAT=plain`        | `custom`      | Dump is human-readable; increases sensitivity of exported archives                        |
| `CACHE_HOST=` (empty)             | `cache`       | Disables Redis flush after restore; Directus may serve stale data from cache post-restore |


