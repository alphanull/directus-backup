# Database Adapter

This release supports **PostgreSQL only**. The runner scripts keep a small adapter boundary internally (`scripts/adapters/postgres.sh`) so other database engines can be added later, but non-PostgreSQL adapters are not supported by the API, sanity checks, restore validation, documentation examples, or test matrix today.

If `DB_ADAPTER` is set to anything other than `postgres`, the installation sanity check fails and backup/restore operations are blocked.

## How It Works

```text
backup.sh / restore.sh (runner)
  │
  ├── sources adapters/${DB_ADAPTER}.sh
  ├── calls db_init, db_backup, db_restore, …
  │
  ├── handles assets (tar), extensions, checksums
  └── handles post-restore count verification
```

Both runner scripts receive `DB_ADAPTER` as an environment variable (default: `postgres`). The only supported value is `postgres`. They resolve the adapter file relative to themselves:

```sh
ADAPTER_FILE="$(dirname "$0")/adapters/${DB_ADAPTER}.sh"
. "$ADAPTER_FILE"
```

On the Node side (`src/api/core/config.ts`), `DB_ADAPTER` is read first, then `DB_CLIENT`, then defaults to `postgres`, and is passed to the runner scripts. Because Directus uses `DB_CLIENT=pg`, the build maps `pg` to the `postgres` adapter; there is no `pg` adapter file.

Do not set a non-PostgreSQL `DB_ADAPTER` in this release. The sanity check intentionally rejects unsupported adapters instead of pretending they are ready.

## Adapter Interface

Every adapter must define these 6 functions:

### `db_init`

Set up authentication and client variables. Called once before any backup or restore operation.

```sh
db_init() {
  export PGPASSWORD="$DB_PASSWORD"
}
```

**Available env vars:** `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`.

### `db_backup $backup_path $include_tables $exclude_tables`

Create a database dump file inside `$backup_path`.

| Arg                    | Description                                                          |
| ---------------------- | ------------------------------------------------------------------- |
| `$1` — backup_path     | Directory to write the dump file into                               |
| `$2` — include_tables  | Comma-separated allowlist of tables to dump (empty = all tables)    |
| `$3` — exclude_tables  | Comma-separated blocklist of tables to skip (empty = none); only consulted when `$2` is empty |

`$2` and `$3` are mutually exclusive: if `$2` is non-empty, `$3` is ignored. The dump file must be named `database.dump`.

### `db_restore $backup_path $include_tables`

Restore a database dump from `$backup_path` into the live database.

| Arg                   | Description                                             |
| --------------------- | ------------------------------------------------------ |
| `$1` — backup_path    | Directory containing the dump file                     |
| `$2` — include_tables | Comma-separated allowlist of tables to restore (empty = full restore) |

Two distinct paths based on `$2`:

- **Full restore** (`$2` empty): reset the schema (e.g. `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`) before restoring the dump. This is the point of no return — a failure afterwards can leave the DB in a partial state.
- **Targeted restore** (`$2` non-empty): `DELETE FROM` each listed table (with FK triggers disabled in a single transaction) and restore only their data — do **not** reset the schema; all other tables remain untouched.

Responsibilities: verify the dump file exists (print a warning and `return` if missing); exit with a non-zero code on fatal errors.

### `db_dump_table_count $dump_file`

Print the number of data tables contained in the dump file to **stdout**. Used for verification logging.

```sh
db_dump_table_count() {
  pg_restore --list "$1" 2>/dev/null | grep -c "TABLE DATA" || echo 0
}
```

### `db_dump_table_list $dump_file`

Print the bare table names of the data tables in the dump to **stdout**, one per line. Used to build the positive collection index (`scope.collections`), which lets the restore UI offer exactly the collections present in the backup without comparing against the live schema.

```sh
db_dump_table_list() {
  pg_restore --list "$1" 2>/dev/null \
    | awk '$4 == "TABLE" && $5 == "DATA" { print $7 }'
}
```

### `db_counts $output_file`

Query the **live database** for row counts of the 10 Directus system tables and write them to `$output_file` in `key=value` format:

```text
directus_collections=12
directus_fields=87
directus_relations=5
…
```

Used by `backup.sh` (to record counts) and `restore.sh` (to verify them after restore).

## Future Adapter Work

The function contract below is retained as an internal starting point for future adapters. It is **not** enough to make a new database engine supported: the Node-side sanity checks, pre-restore dump validation, documentation, examples, and integration tests would also need adapter-specific support.

## Experimental Adapter Skeleton

1. Create `scripts/adapters/<name>.sh` (e.g. `scripts/adapters/mysql.sh`).
2. Implement all 6 functions listed above.
3. Add adapter-specific sanity checks and pre-restore dump validation in the API.
4. Install the required client tools in the **Directus Dockerfile**.
5. Add tests and documentation before declaring the adapter supported.

### Skeleton

```sh
#!/bin/sh
# <Name> adapter for the backup runner.

db_init() {
  # Set up auth, e.g. write a config file or export credentials
}

db_backup() {
  _path="$1"; _include="$2"; _exclude="$3"
  # Create dump at $_path/database.dump
  # If _include is non-empty, dump only those tables (ignore _exclude)
  # If _include is empty and _exclude is non-empty, exclude those tables
}

db_restore() {
  _path="$1"; _include="$2"
  # Verify dump file exists (return early if not)
  # If _include is empty: reset schema, then full restore
  # If _include is non-empty: targeted data-only restore
}

db_dump_table_count() {
  _file="$1"
  # Print number of data tables in dump to stdout
}

db_dump_table_list() {
  _file="$1"
  # Print bare table names in dump to stdout, one per line
}

db_counts() {
  # Query live DB, write key=value counts to $1
}
```

### Adapter-Specific Considerations

| Concern           | Notes                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Table excludes**| PostgreSQL uses `--table=` / `--exclude-table=` (one flag per table). MySQL has `--ignore-table`. SQLite has no native exclude support.|
| **Schema reset**  | PostgreSQL uses `DROP SCHEMA public CASCADE`. MySQL needs `DROP DATABASE` + `CREATE DATABASE`. SQLite can just delete the file.        |
| **Exit codes**    | PostgreSQL treats exit code 1 as non-fatal warnings. Other tools may differ — handle accordingly in `db_restore`.                      |
| **Dockerfile**    | Each adapter may require its own client package (e.g. `postgresql16-client`, `mysql-client`, `sqlite`).                                |
