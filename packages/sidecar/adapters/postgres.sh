#!/bin/sh
# PostgreSQL adapter for the backup runner.
#
# Implements the db_* interface consumed by run.sh:
#   db_init              — set up PG auth and client vars
#   db_backup            — pg_dump to $BACKUP_PATH
#   db_restore           — pg_restore into the live DB
#   db_dump_table_count  — count data tables in the dump file
#   db_dump_table_list   — list bare table names in the dump file
#   db_counts            — query row counts for Directus system tables

PSQL="psql --host=$DB_HOST --port=5432 --username=$DB_USER --dbname=$DB_DATABASE"

# ── db_init ────────────────────────────────────────────────────

db_init() {
  export PGPASSWORD="$DB_PASSWORD"
}

# ── db_backup ──────────────────────────────────────────────────
# Args: $1 = backup_path, $2 = dump_format,
#       $3 = include_tables (comma-separated; empty = all),
#       $4 = exclude_tables (comma-separated; empty = none)
# include_tables and exclude_tables are mutually exclusive.
# include_tables takes precedence if both are set.

db_backup() {
  _path="$1"; _fmt="$2"; _include="$3"; _exclude="${4:-}"

  TABLE_ARGS=""
  if [ -n "$_include" ]; then
    for tbl in $(echo "$_include" | tr ',' ' '); do
      TABLE_ARGS="$TABLE_ARGS --table=$tbl"
    done
    echo "Including tables in dump: $_include"
  elif [ -n "$_exclude" ]; then
    for tbl in $(echo "$_exclude" | tr ',' ' '); do
      TABLE_ARGS="$TABLE_ARGS --exclude-table=$tbl"
    done
    echo "Excluding tables from dump: $_exclude"
  fi

  if [ "$_fmt" = "plain" ]; then
    DUMP_FILE="$_path/database.sql"
    pg_dump \
      --host="$DB_HOST" --port=5432 --username="$DB_USER" \
      --format=plain --clean --if-exists --file="$DUMP_FILE" \
      $TABLE_ARGS \
      "$DB_DATABASE"
  else
    DUMP_FILE="$_path/database.dump"
    pg_dump \
      --host="$DB_HOST" --port=5432 --username="$DB_USER" \
      --format=custom --file="$DUMP_FILE" \
      $TABLE_ARGS \
      "$DB_DATABASE"
  fi
  echo "pg_dump complete: $DUMP_FILE"
}

# ── db_restore ─────────────────────────────────────────────────
# Args: $1 = backup_path, $2 = dump_format, $3 = include_tables (comma-separated; empty = full restore)
#
# Two distinct paths:
#   include_tables set   — targeted restore: DELETE + data-only pg_restore for each
#                          listed table. The schema is NOT reset; all other tables
#                          in the live DB remain untouched.
#   include_tables empty — full restore: DROP SCHEMA + full pg_restore. This is the
#                          normal case and the point of no return (see note below).
#
# Full-restore note: every branch of the empty-include path resets the public schema
# ("DROP SCHEMA public CASCADE") before loading the dump. That reset is the point of
# no return — a fatal failure afterwards leaves the live DB in a broken/partial state
# that requires manual recovery. This is inherent to an in-place restore and is
# mitigated, not eliminated:
#   - dump integrity is verified by run.sh (checksums) BEFORE this runs;
#   - the backup being restored is the source of truth, so the usual remedy for an
#     environmental failure (disk/connection/permissions) is to fix it and re-run.

db_restore() {
  _path="$1"; _fmt="$2"; _include="$3"

  # Check that the dump file exists
  if [ "$_fmt" = "plain" ] && [ ! -f "$_path/database.sql" ]; then
    echo "WARNING: database.sql not found in backup — skipping DB restore"
    return
  elif [ "$_fmt" != "plain" ] && [ ! -f "$_path/database.dump" ]; then
    echo "WARNING: database.dump not found in backup — skipping DB restore"
    return
  fi

  if [ -n "$_include" ] && [ "$_fmt" = "custom" ]; then
    echo "Targeted restore — included tables: $_include"

    # DELETE all rows from each included table with FK triggers disabled in a single
    # transaction. Unlike TRUNCATE, DELETE respects session_replication_role=replica
    # and does not trigger PostgreSQL's schema-level FK referencing check, which
    # would block TRUNCATE whenever another table holds a FK pointing at the target
    # table — regardless of whether any rows actually reference it.
    # Table names originate from scope.includeCollections, which the sidecar
    # validates against COLLECTION_NAME_RE (plain identifier charset) before it
    # ever reaches this script — so the quoted identifier below cannot be broken
    # out of via quotes, semicolons, whitespace, or shell glob characters.
    {
      echo "BEGIN;"
      echo "SET LOCAL session_replication_role = 'replica';"
      for tbl in $(echo "$_include" | tr ',' ' '); do
        echo "DELETE FROM \"$tbl\";"
      done
      echo "COMMIT;"
    } | $PSQL

    # Restore only the listed tables' data.
    # --disable-triggers sets session_replication_role=replica inside the restore
    # session so FK constraint triggers do not fire during the COPY commands.
    # This is required when included tables reference excluded ones; the dependency
    # warning in the UI informs the user that FK consistency is their responsibility.
    TABLE_ARGS=""
    for tbl in $(echo "$_include" | tr ',' ' '); do
      TABLE_ARGS="$TABLE_ARGS --table=$tbl"
    done
    set +e
    pg_restore \
      --host="$DB_HOST" --port=5432 --username="$DB_USER" \
      --dbname="$DB_DATABASE" \
      --no-owner --data-only \
      --disable-triggers \
      $TABLE_ARGS \
      "$_path/database.dump"
    PG_EXIT=$?
    set -e
    if [ "$PG_EXIT" -gt 1 ]; then
      echo "pg_restore fatal error (code=$PG_EXIT)"
      echo "Targeted restore failed (pg_restore code=$PG_EXIT)." > "$_path/restore-error.txt"
      exit "$PG_EXIT"
    fi
    [ "$PG_EXIT" -eq 1 ] && echo "pg_restore completed with warnings (code=1, non-fatal)"

  elif [ -n "$_include" ] && [ "$_fmt" = "plain" ]; then
    echo "WARNING: Collection includes not supported with plain format — doing full restore"
    echo "Resetting public schema..."
    $PSQL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>&1
    echo "Schema reset done"
    $PSQL --single-transaction < "$_path/database.sql"

  else
    # Full restore (no include filter).
    # pg_restore --clean cannot handle Directus's circular FK constraints reliably.
    echo "Resetting public schema..."
    $PSQL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>&1
    echo "Schema reset done"

    if [ "$_fmt" = "plain" ]; then
      $PSQL --single-transaction < "$_path/database.sql"
    else
      set +e
      pg_restore \
        --host="$DB_HOST" --port=5432 --username="$DB_USER" \
        --dbname="$DB_DATABASE" \
        --no-owner \
        "$_path/database.dump"
      PG_EXIT=$?
      set -e
      if [ "$PG_EXIT" -gt 1 ]; then
        echo "pg_restore fatal error (code=$PG_EXIT)"
        exit "$PG_EXIT"
      fi
      [ "$PG_EXIT" -eq 1 ] && echo "pg_restore completed with warnings (code=1, non-fatal)"
    fi
  fi
  echo "Database restore complete"
}

# ── db_dump_table_count ────────────────────────────────────────
# Args: $1 = dump_file, $2 = dump_format
# Prints the number of data tables in the dump to stdout.

db_dump_table_count() {
  _file="$1"; _fmt="$2"
  if [ "$_fmt" = "plain" ]; then
    grep -c "^COPY " "$_file" 2>/dev/null || echo 0
  else
    pg_restore --list "$_file" 2>/dev/null | grep -c "TABLE DATA" || echo 0
  fi
}

# ── db_dump_table_list ─────────────────────────────────────────
# Args: $1 = dump_file, $2 = dump_format
# Prints the bare table names of the data tables contained in the dump, one per
# line. This is the positive index of what the backup actually holds: tables
# excluded at backup time are absent from the dump and therefore from this list.

db_dump_table_list() {
  _file="$1"; _fmt="$2"
  if [ "$_fmt" = "plain" ]; then
    grep "^COPY " "$_file" 2>/dev/null \
      | sed -e 's/^COPY //' -e 's/ .*//' -e 's/^[^.]*\.//' -e 's/"//g'
  else
    pg_restore --list "$_file" 2>/dev/null \
      | awk '$4 == "TABLE" && $5 == "DATA" { print $7 }'
  fi
}

# ── db_counts ──────────────────────────────────────────────────
# Args: $1 = output_file
# Writes key=value row counts for 10 Directus system tables.

db_counts() {
  $PSQL -t -A << 'SQL' > "$1"
SELECT 'directus_collections=' || COUNT(*) FROM directus_collections
UNION ALL SELECT 'directus_fields='      || COUNT(*) FROM directus_fields
UNION ALL SELECT 'directus_relations='   || COUNT(*) FROM directus_relations
UNION ALL SELECT 'directus_policies='    || COUNT(*) FROM directus_policies
UNION ALL SELECT 'directus_roles='       || COUNT(*) FROM directus_roles
UNION ALL SELECT 'directus_users='       || COUNT(*) FROM directus_users
UNION ALL SELECT 'directus_access='      || COUNT(*) FROM directus_access
UNION ALL SELECT 'directus_permissions=' || COUNT(*) FROM directus_permissions
UNION ALL SELECT 'directus_flows='       || COUNT(*) FROM directus_flows
UNION ALL SELECT 'directus_settings='    || COUNT(*) FROM directus_settings
SQL
}
