#!/bin/sh
# Directus container entrypoint for the standalone backup extension.
#
# NOTE: The example Dockerfile embeds this exact content via a heredoc, so this
# file is only needed for build environments without BuildKit heredoc support
# (legacy `docker build`, Docker < 23). For the classic two-file variant, COPY
# this file in your Dockerfile instead — see docs/installation.md.
#
# On a clean boot — before Directus starts and while the database has zero
# application connections — run a pending restore if one was armed, then hand
# off to the stock Directus entrypoint. The extension arms a restore by writing
# a flag to the backup volume and signalling PID 1; the container's
# `restart: unless-stopped` policy brings the container back here.
#
# This stub is intentionally generic: it only locates and runs the extension's
# restore.sh, which owns the actual restore logic. Without the extension it is a
# no-op pass-through.

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
