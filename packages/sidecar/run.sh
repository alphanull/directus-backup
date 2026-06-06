#!/bin/sh
set -e

RUNNER_MODE="${RUNNER_MODE:-backup}"
BACKUP_ID="${BACKUP_ID:?Missing BACKUP_ID}"
BACKUP_PATH="${BACKUP_PATH:?Missing BACKUP_PATH}"
DUMP_FORMAT="${BACKUP_DUMP_FORMAT:-custom}"
DB_HOST="${DB_HOST:?Missing DB_HOST}"
DB_USER="${DB_USER:?Missing DB_USER}"
DB_PASSWORD="${DB_PASSWORD:?Missing DB_PASSWORD}"
DB_DATABASE="${DB_DATABASE:?Missing DB_DATABASE}"
UPLOADS_DIR="${UPLOADS_DIR:-/directus/uploads}"
EXTENSIONS_DIR="${EXTENSIONS_DIR:-/directus/extensions}"

BACKUP_INCLUDE_DB="${BACKUP_INCLUDE_DB:-1}"
BACKUP_INCLUDE_ASSETS="${BACKUP_INCLUDE_ASSETS:-1}"
BACKUP_INCLUDE_EXTENSIONS="${BACKUP_INCLUDE_EXTENSIONS:-0}"
BACKUP_INCLUDE_TABLES="${BACKUP_INCLUDE_TABLES:-}"
BACKUP_EXCLUDE_TABLES="${BACKUP_EXCLUDE_TABLES:-}"
RESTORE_INCLUDE_DB="${RESTORE_INCLUDE_DB:-1}"
RESTORE_INCLUDE_ASSETS="${RESTORE_INCLUDE_ASSETS:-1}"
RESTORE_INCLUDE_EXTENSIONS="${RESTORE_INCLUDE_EXTENSIONS:-0}"
RESTORE_INCLUDE_TABLES="${RESTORE_INCLUDE_TABLES:-}"

# ── Load database adapter ─────────────────────────────────────

DB_ADAPTER="${DB_ADAPTER:-postgres}"
ADAPTER_FILE="$(dirname "$0")/adapters/${DB_ADAPTER}.sh"
[ -f "$ADAPTER_FILE" ] || { echo "Unknown DB adapter: $DB_ADAPTER"; exit 1; }
. "$ADAPTER_FILE"

db_init

# ── Backup ────────────────────────────────────────────────────

if [ "$RUNNER_MODE" = "backup" ]; then
  echo "Starting backup: $BACKUP_ID (adapter=$DB_ADAPTER, format=$DUMP_FORMAT)"
  mkdir -p "$BACKUP_PATH"

  # ── Database ──
  if [ "$BACKUP_INCLUDE_DB" = "1" ]; then
    db_backup "$BACKUP_PATH" "$DUMP_FORMAT" "$BACKUP_INCLUDE_TABLES" "$BACKUP_EXCLUDE_TABLES"
  else
    echo "Database backup skipped (BACKUP_INCLUDE_DB=0)"
  fi

  # ── Assets ──
  if [ "$BACKUP_INCLUDE_ASSETS" = "1" ]; then
    # Archive the *contents* of UPLOADS_DIR (stored as ./…), so the configured
    # path — not a hard-coded /directus/uploads — is what gets backed up and the
    # archive can be restored into any UPLOADS_DIR regardless of its basename.
    tar czf "$BACKUP_PATH/uploads.tar.gz" \
      --exclude="./directus-health-file" \
      -C "$UPLOADS_DIR" .
    echo "uploads tar complete"
  else
    echo "Assets backup skipped (BACKUP_INCLUDE_ASSETS=0)"
  fi

  # ── Extensions ──
  if [ "$BACKUP_INCLUDE_EXTENSIONS" = "1" ]; then
    # Build the member list relative to EXTENSIONS_DIR (paths like myext/dist),
    # then tar with -C "$EXTENSIONS_DIR". This keeps the selective layout
    # (.registry, package.json, dist) but decouples it from a hard-coded
    # /directus prefix, so a non-standard EXTENSIONS_DIR is backed up correctly.
    EXT_LIST=$(mktemp)
    if [ -d "$EXTENSIONS_DIR" ]; then
      (
        cd "$EXTENSIONS_DIR" || exit 1
        [ -d ".registry" ] && find .registry
        for ext_dir in */; do
          [ -d "$ext_dir" ] || continue
          ext_name=${ext_dir%/}
          [ -f "${ext_dir}package.json" ] && printf '%s/package.json\n' "$ext_name"
          [ -d "${ext_dir}dist" ] && find "${ext_dir}dist"
        done
        # The last test above may be false; force a clean status so set -e in the
        # parent does not abort the backup on the subshell's exit code.
        exit 0
      ) >> "$EXT_LIST"
    fi
    tar czf "$BACKUP_PATH/extensions.tar.gz" -C "$EXTENSIONS_DIR" -T "$EXT_LIST"
    rm -f "$EXT_LIST"
    echo "extensions tar complete"
  else
    echo "Extensions backup skipped (BACKUP_INCLUDE_EXTENSIONS=0)"
  fi

  # ── Verify data ──────────────────────────────────────────────

  echo "Computing checksums..."
  # Build the list of present artefacts as positional args and hash them in a
  # single sha256sum call. Avoids xargs (whose BSD/macOS build can fail with
  # "sysconf(_SC_ARG_MAX)" on some hosts) and the degenerate empty-input case,
  # where xargs would run sha256sum with no args and hash stdin instead.
  (
    cd "$BACKUP_PATH"
    set --
    for f in database.dump database.sql uploads.tar.gz extensions.tar.gz; do
      [ -f "$f" ] && set -- "$@" "$f"
    done
    if [ "$#" -gt 0 ]; then
      sha256sum "$@" > checksums.sha256
    else
      : > checksums.sha256
    fi
  )
  echo "Checksums written"

  if [ "$BACKUP_INCLUDE_DB" = "1" ]; then
    echo "Counting dump tables..."
    if [ "$DUMP_FORMAT" = "plain" ]; then
      DUMP_FILE="$BACKUP_PATH/database.sql"
    else
      DUMP_FILE="$BACKUP_PATH/database.dump"
    fi
    DUMP_TABLES=$(db_dump_table_count "$DUMP_FILE" "$DUMP_FORMAT")
    echo "Dump contains $DUMP_TABLES data table(s)"

    echo "Listing dump tables..."
    db_dump_table_list "$DUMP_FILE" "$DUMP_FORMAT" > "$BACKUP_PATH/db-tables.txt"
    echo "Dump table list written"

    echo "Storing table counts..."
    db_counts "$BACKUP_PATH/db-counts.txt"
    printf '__dump_tables=%d\n' "$DUMP_TABLES" >> "$BACKUP_PATH/db-counts.txt"
    echo "Table counts written"
  fi

# ── Restore ───────────────────────────────────────────────────

elif [ "$RUNNER_MODE" = "restore" ]; then
  echo "Starting restore: $BACKUP_ID (adapter=$DB_ADAPTER, format=$DUMP_FORMAT)"

  # Verify checksums before touching anything
  if [ -f "$BACKUP_PATH/checksums.sha256" ]; then
    echo "Verifying backup checksums..."
    if ! (cd "$BACKUP_PATH" && sha256sum -c checksums.sha256); then
      MSG="Checksum verification failed — backup file(s) are corrupt"
      echo "$MSG"
      echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
      exit 1
    fi
    echo "Checksums OK"
  else
    echo "WARNING: No checksums.sha256 in backup — skipping checksum verify"
  fi

  # Per-component restore outcome (restored|skipped), consumed by the sidecar to
  # report what each component did. A requested component whose file is absent is
  # a hard error (see below), not a silent skip — the import path guarantees that
  # an archive's manifest scope matches its contents, so this can only happen on a
  # manipulated or truncated backup, in which case failing loudly is correct.
  RESTORE_RESULT="$BACKUP_PATH/restore-result.txt"
  : > "$RESTORE_RESULT"

  # ── Database restore ──
  if [ "$RESTORE_INCLUDE_DB" = "1" ]; then
    if { [ "$DUMP_FORMAT" = "plain" ] && [ -f "$BACKUP_PATH/database.sql" ]; } \
      || { [ "$DUMP_FORMAT" != "plain" ] && [ -f "$BACKUP_PATH/database.dump" ]; }; then
      db_restore "$BACKUP_PATH" "$DUMP_FORMAT" "$RESTORE_INCLUDE_TABLES"
      echo "db=restored" >> "$RESTORE_RESULT"
    else
      MSG="Database restore requested but no dump found in backup"
      echo "$MSG"
      echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
      exit 1
    fi
  else
    echo "Database restore skipped (RESTORE_INCLUDE_DB=0)"
    echo "db=skipped" >> "$RESTORE_RESULT"
  fi

  # ── Assets restore ──
  if [ "$RESTORE_INCLUDE_ASSETS" = "1" ]; then
    if [ -f "$BACKUP_PATH/uploads.tar.gz" ]; then
      find "${UPLOADS_DIR:?}" -mindepth 1 -delete
      mkdir -p "$UPLOADS_DIR"
      tar xzf "$BACKUP_PATH/uploads.tar.gz" -C "$UPLOADS_DIR"
      echo "uploads restore complete"
      echo "assets=restored" >> "$RESTORE_RESULT"
    else
      MSG="Assets restore requested but uploads.tar.gz not found in backup"
      echo "$MSG"
      echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
      exit 1
    fi
  else
    echo "Assets restore skipped (RESTORE_INCLUDE_ASSETS=0)"
    echo "assets=skipped" >> "$RESTORE_RESULT"
  fi

  # ── Extensions restore ──
  if [ "$RESTORE_INCLUDE_EXTENSIONS" = "1" ]; then
    if [ -f "$BACKUP_PATH/extensions.tar.gz" ]; then
      if [ -d "${EXTENSIONS_DIR}/.registry" ]; then
        rm -rf "${EXTENSIONS_DIR}/.registry"
      fi
      for ext_dir in "${EXTENSIONS_DIR}"/*/; do
        [ -d "$ext_dir" ] || continue
        rm -rf "${ext_dir}dist"
        rm -f "${ext_dir}package.json"
      done
      mkdir -p "$EXTENSIONS_DIR"
      tar xzf "$BACKUP_PATH/extensions.tar.gz" -C "$EXTENSIONS_DIR"
      echo "extensions restore complete"
      echo "extensions=restored" >> "$RESTORE_RESULT"
    else
      MSG="Extensions restore requested but extensions.tar.gz not found in backup"
      echo "$MSG"
      echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
      exit 1
    fi
  else
    echo "Extensions restore skipped (RESTORE_INCLUDE_EXTENSIONS=0)"
    echo "extensions=skipped" >> "$RESTORE_RESULT"
  fi

  # ── Post-restore count verification ──────────────────────────

  if [ "$RESTORE_INCLUDE_DB" = "1" ] && [ -f "$BACKUP_PATH/db-counts.txt" ]; then
    echo "Verifying restored table counts..."
    db_counts /tmp/actual-counts.txt
    MISMATCHES=0
    MISMATCH_FILE=/tmp/verify-mismatches.txt
    rm -f "$MISMATCH_FILE"

    INCLUDE_SET=""
    if [ -n "$RESTORE_INCLUDE_TABLES" ]; then
      INCLUDE_SET=",$RESTORE_INCLUDE_TABLES,"
    fi

    while IFS='=' read -r table expected; do
      case "$table" in ''|__*) continue ;; esac
      # Skip count check for tables not included in this restore.
      if [ -n "$INCLUDE_SET" ] && ! echo "$INCLUDE_SET" | grep -q ",$table,"; then
        continue
      fi
      actual=$(grep "^${table}=" /tmp/actual-counts.txt | cut -d= -f2)
      if [ "${actual:-0}" != "$expected" ]; then
        MISMATCHES=$((MISMATCHES + 1))
        echo "  MISMATCH: $table expected=$expected actual=${actual:-0}"
        printf 'mismatch.%s=%s->%s\n' "$table" "$expected" "${actual:-0}" >> "$MISMATCH_FILE"
      fi
    done < "$BACKUP_PATH/db-counts.txt"
    {
      printf 'mismatches=%d\n' "$MISMATCHES"
      [ -f "$MISMATCH_FILE" ] && cat "$MISMATCH_FILE"
    } > "$BACKUP_PATH/restore-verify.txt"
    [ "$MISMATCHES" -eq 0 ] \
      && echo "All table counts verified OK" \
      || echo "WARNING: $MISMATCHES table count mismatch(es) — see restore-verify.txt"
  fi

else
  echo "Unknown RUNNER_MODE: $RUNNER_MODE"
  exit 1
fi

echo "Runner done: $BACKUP_ID"
