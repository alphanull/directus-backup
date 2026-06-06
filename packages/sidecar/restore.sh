#!/bin/sh
# Restore a backup by ID without Directus Studio access.
#
# Required environment variables:
#   BACKUP_DIR       Path to the backups directory
#   BACKUP_SECRET    Sidecar auth secret (prompted if missing)
#   CONTAINER        Backup sidecar container name (prompted if missing)
#
# Usage:
#   BACKUP_DIR=./directus/backups CONTAINER=myapp-backup-1 ./restore.sh
#   BACKUP_DIR=./directus/backups ./restore.sh 2026-02-20__14-30-00__manual

set -e

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR required — set to your backups directory}"
BACKUP_SECRET="${BACKUP_SECRET:-}"
CONTAINER="${CONTAINER:-}"

if [ -z "$BACKUP_SECRET" ]; then
  printf "BACKUP_SECRET: "
  read -r BACKUP_SECRET
fi

if [ -z "$CONTAINER" ]; then
  printf "Backup container name: "
  read -r CONTAINER
fi

# ── Backup selection ──────────────────────────────────────────

BACKUP_ID="${1:-}"

if [ -z "$BACKUP_ID" ]; then
  BACKUPS=""
  if [ -d "$BACKUP_DIR" ]; then
    for manifest in "$BACKUP_DIR"/*/backup.json; do
      [ -f "$manifest" ] || continue
      dir=$(dirname "$manifest")
      id=$(basename "$dir")
      status=$(grep -o '"status": *"[^"]*"' "$manifest" 2>/dev/null | head -1 | sed 's/.*: *"//' | tr -d '"')
      label=$(grep -o '"label": *"[^"]*"' "$manifest" 2>/dev/null | head -1 | sed 's/.*: *"//' | tr -d '"')
      fmt=$(grep -o '"dumpFormat": *"[^"]*"' "$manifest" 2>/dev/null | head -1 | sed 's/.*: *"//' | tr -d '"')
      BACKUPS="${BACKUPS}${id}	${status:-?}	${label:-?}	${fmt:-?}
"
    done
    BACKUPS=$(echo "$BACKUPS" | sort -r | grep -v '^$')
  fi

  if [ -z "$BACKUPS" ]; then
    echo "No backups found in $BACKUP_DIR"
    exit 1
  fi

  echo ""
  echo "Available backups:"
  echo ""

  i=1
  echo "$BACKUPS" | while IFS= read -r line; do
    id=$(echo "$line" | cut -f1)
    status=$(echo "$line" | cut -f2)
    label=$(echo "$line" | cut -f3)
    fmt=$(echo "$line" | cut -f4)
    printf "  [%d] %s  (%s, %s, %s)\n" "$i" "$id" "$label" "$status" "$fmt"
    i=$((i + 1))
  done

  echo ""
  printf "Select backup number: "
  read -r CHOICE

  BACKUP_ID=$(echo "$BACKUPS" | sed -n "${CHOICE}p" | cut -f1)

  if [ -z "$BACKUP_ID" ]; then
    echo "Invalid selection."
    exit 1
  fi
fi

# ── Confirm ───────────────────────────────────────────────────

echo ""
echo "  Backup:    $BACKUP_ID"
echo "  Container: $CONTAINER"
echo ""
printf "Restore this backup? Directus will be restarted. [y/N] "
read -r CONFIRM

case "$CONFIRM" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

# ── Trigger ───────────────────────────────────────────────────

echo ""
echo "Triggering restore: $BACKUP_ID"

# Pass the secret (and ID) through the environment with `docker exec -e NAME`
# (no value in argv) so they don't appear in the host process list. The secret
# is still expanded into wget's argv inside the container, but it already lives
# there as the sidecar's own env var, so this is no new disclosure.
export BACKUP_SECRET BACKUP_ID
docker exec -e BACKUP_SECRET -e BACKUP_ID "$CONTAINER" sh -c '
  wget -qO- \
    --header="X-Backup-Secret: $BACKUP_SECRET" \
    --header="Content-Type: application/json" \
    --post-data="{\"backupId\":\"$BACKUP_ID\"}" \
    http://127.0.0.1:4700/restore
'

echo ""
echo "Restore accepted. Monitor with: docker logs -f $CONTAINER"
