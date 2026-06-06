# Database Adapters

The backup runner (`run.sh`) uses a pluggable adapter system to support different database engines. Each adapter is a shell script in `adapters/` that implements a fixed set of functions.

## How It Works

```
run.sh (runner)
  │
  ├── sources adapters/${DB_ADAPTER}.sh
  ├── calls db_init, db_backup, db_restore, …
  │
  ├── handles assets (tar), extensions, checksums
  └── handles post-restore count verification
```

`run.sh` receives `DB_ADAPTER` as an environment variable (default: `postgres`). It resolves the adapter file relative to itself:

```sh
ADAPTER_FILE="$(dirname "$0")/adapters/${DB_ADAPTER}.sh"
. "$ADAPTER_FILE"
```

On the Node side, `DB_ADAPTER` is read first, then `DB_CLIENT`, then defaults to `postgres`. It is passed to `run.sh` via `buildRunnerEnv()` in `lib/runner.js`. If you share Directus database environment variables with the sidecar, set `DB_ADAPTER=postgres` explicitly when Directus uses `DB_CLIENT=pg`; there is no built-in `pg` adapter file.

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

### `db_backup $backup_path $dump_format $include_tables $exclude_tables`

Create a database dump file inside `$backup_path`.

| Arg | Description |
|-----|-------------|
| `$1` — backup_path | Directory to write the dump file into |
| `$2` — dump_format | `custom` or `plain` (adapter may ignore or map these) |
| `$3` — include_tables | Comma-separated allowlist of tables to dump (empty = all tables) |
| `$4` — exclude_tables | Comma-separated blocklist of tables to skip (empty = none); only consulted when `$3` is empty |

`$3` and `$4` are mutually exclusive: if `$3` is non-empty, `$4` is ignored.

The dump file must be named either `database.dump` (binary/custom) or `database.sql` (plain text), matching the format.

### `db_restore $backup_path $dump_format $include_tables`

Restore a database dump from `$backup_path` into the live database.

| Arg | Description |
|-----|-------------|
| `$1` — backup_path | Directory containing the dump file |
| `$2` — dump_format | `custom` or `plain` |
| `$3` — include_tables | Comma-separated allowlist of tables to restore (empty = full restore) |

Two distinct paths based on `$3`:

- **Full restore** (`$3` empty): reset the schema (e.g. `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`) before restoring the dump. This is the point of no return — a failure afterwards can leave the DB in a partial state.
- **Targeted restore** (`$3` non-empty, custom format only): `DELETE FROM` each listed table (with FK triggers disabled in a single transaction) and restore only their data — do **not** reset the schema; all other tables remain untouched. If the format does not support targeted restores, log a warning and fall back to a full restore.

Responsibilities:
- Verify the dump file exists (print a warning and `return` if missing).
- Exit with a non-zero code on fatal errors.

### `db_dump_table_count $dump_file $dump_format`

Print the number of data tables contained in the dump file to **stdout**. Used for verification logging.

```sh
db_dump_table_count() {
  pg_restore --list "$1" 2>/dev/null | grep -c "TABLE DATA" || echo 0
}
```

### `db_dump_table_list $dump_file $dump_format`

Print the bare table names of the data tables contained in the dump file to **stdout**, one per line. Used to build the positive collection index (`scope.collections` in the manifest), which lets the restore UI offer exactly the collections present in the backup without comparing against the live schema.

```sh
db_dump_table_list() {
  if [ "$2" = "plain" ]; then
    grep "^COPY " "$1" 2>/dev/null \
      | sed -e 's/^COPY //' -e 's/ .*//' -e 's/^[^.]*\.//' -e 's/"//g'
  else
    pg_restore --list "$1" 2>/dev/null \
      | awk '$4 == "TABLE" && $5 == "DATA" { print $7 }'
  fi
}
```

### `db_counts $output_file`

Query the **live database** for row counts of the 10 Directus system tables and write them to `$output_file` in `key=value` format:

```
directus_collections=12
directus_fields=87
directus_relations=5
…
```

This is used by `run.sh` to compare counts before backup and after restore.

## Writing a New Adapter

1. Create `adapters/<name>.sh` (e.g. `adapters/mysql.sh`).
2. Implement all 6 functions listed above.
3. Install the required client tools in the `Dockerfile` (e.g. `mysql-client`).
4. Add a `COPY` for the new file if it isn't already covered by the `adapters/` directory copy.
5. Set `DB_ADAPTER=<name>` in the sidecar environment. `DB_CLIENT=<name>` is only a fallback; prefer `DB_ADAPTER` so Directus-specific aliases such as `pg` do not point to a missing adapter file.

### Skeleton

```sh
#!/bin/sh
# <Name> adapter for the backup runner.

db_init() {
  # Set up auth, e.g. write a config file or export credentials
}

db_backup() {
  _path="$1"; _fmt="$2"; _include="$3"; _exclude="$4"
  # Create dump at $_path/database.dump or $_path/database.sql
  # If _include is non-empty, dump only those tables (ignore _exclude)
  # If _include is empty and _exclude is non-empty, exclude those tables
}

db_restore() {
  _path="$1"; _fmt="$2"; _include="$3"
  # Verify dump file exists (return early if not)
  # If _include is empty: reset schema, then full restore
  # If _include is non-empty (custom format only): targeted data-only restore
}

db_dump_table_count() {
  _file="$1"; _fmt="$2"
  # Print number of data tables in dump to stdout
}

db_dump_table_list() {
  _file="$1"; _fmt="$2"
  # Print bare table names in dump to stdout, one per line
}

db_counts() {
  # Query live DB, write key=value counts to $1
}
```

### Adapter-Specific Considerations

| Concern | Notes |
|---------|-------|
| **Dump format** | `custom`/`plain` originate from PostgreSQL. Map to whatever your DB supports. If only one format exists, ignore `$dump_format`. |
| **Table excludes** | PostgreSQL uses `--table=<name>` / `--exclude-table=<name>` flags (one flag per table). MySQL has `--ignore-table`. SQLite has no native exclude support. Treat excludes as best-effort. |
| **Schema reset** | PostgreSQL uses `DROP SCHEMA public CASCADE`. MySQL needs `DROP DATABASE` + `CREATE DATABASE`. SQLite can just delete the file. |
| **Exit codes** | PostgreSQL treats exit code 1 as non-fatal warnings. Other tools may differ — handle accordingly in `db_restore`. |
| **Dockerfile** | Each adapter may require its own client package (e.g. `postgresql16-client`, `mysql-client`, `sqlite`). |
