#!/bin/sh
# Backup runner — spawned live by the extension while Directus is running.
#
# Produces the raw artefacts of a backup (database dump, asset/extension
# archives, checksums and verification metadata) into $BACKUP_PATH. The
# extension owns backup.json; this script only writes artefacts.
#
# Database credentials and scope (BACKUP_INCLUDE_*) are passed in via the
# environment by the extension.
#
# @author  Frank Kudermann – alphanull
# @license AGPL-3.0-only

set -e

BACKUP_ID="${BACKUP_ID:?Missing BACKUP_ID}"
BACKUP_PATH="${BACKUP_PATH:?Missing BACKUP_PATH}"
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

# ── Load database adapter ─────────────────────────────────────

DB_ADAPTER="${DB_ADAPTER:-postgres}"
ADAPTER_FILE="$(dirname "$0")/adapters/${DB_ADAPTER}.sh"
[ -f "$ADAPTER_FILE" ] || { echo "Unknown DB adapter: $DB_ADAPTER"; exit 1; }
# shellcheck disable=SC1090
. "$ADAPTER_FILE"

db_init

# ── Backup ────────────────────────────────────────────────────

echo "Starting backup: $BACKUP_ID (adapter=$DB_ADAPTER)"
mkdir -p "$BACKUP_PATH"

# ── Database ──
if [ "$BACKUP_INCLUDE_DB" = "1" ]; then
  db_backup "$BACKUP_PATH" "$BACKUP_INCLUDE_TABLES" "$BACKUP_EXCLUDE_TABLES"
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
  # Build the member list relative to EXTENSIONS_DIR, then tar with
  # -C "$EXTENSIONS_DIR". Registry installs are kept as-is; direct extension
  # folders are backed up as packages while pruning dependency trees.
  EXT_LIST=$(mktemp)
  if [ -d "$EXTENSIONS_DIR" ]; then
    (
      cd "$EXTENSIONS_DIR" || exit 1
      [ -d ".registry" ] && find .registry \( -type f -o -type l -o -type d -empty \) -print
      for ext_dir in */; do
        [ -d "$ext_dir" ] || continue
        ext_name=${ext_dir%/}
        find "$ext_name" \
          \( -path "*/node_modules" -o -path "*/node_modules/*" \) -prune -o \
          \( -type f -o -type l -o -type d -empty \) -print
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
  for f in database.dump uploads.tar.gz extensions.tar.gz; do
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
  DUMP_FILE="$BACKUP_PATH/database.dump"
  DUMP_TABLES=$(db_dump_table_count "$DUMP_FILE")
  echo "Dump contains $DUMP_TABLES data table(s)"

  echo "Listing dump tables..."
  db_dump_table_list "$DUMP_FILE" > "$BACKUP_PATH/db-tables.txt"
  echo "Dump table list written"

  echo "Storing table counts..."
  db_counts "$BACKUP_PATH/db-counts.txt"
  printf '__dump_tables=%d\n' "$DUMP_TABLES" >> "$BACKUP_PATH/db-counts.txt"
  echo "Table counts written"
fi

echo "Backup done: $BACKUP_ID"
