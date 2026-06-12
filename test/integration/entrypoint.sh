#!/bin/sh
# Directus container entrypoint (Mechanism A for the backup extension).
#
# On a clean boot — before Directus starts and while the database has zero
# application connections — run a pending restore if one was armed, then hand
# off to the stock Directus entrypoint. The backup extension arms a restore by
# writing a flag to the backup volume and signalling PID 1; the container's
# `restart: unless-stopped` policy brings the container back here.
#
# This stub is intentionally generic: it only locates and runs the extension's
# restore.sh, which owns the actual restore logic. Removing the extension makes
# this a no-op pass-through. Mirrors the production stub.

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
