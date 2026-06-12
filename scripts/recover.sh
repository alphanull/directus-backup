#!/bin/sh
# Disaster-recovery CLI for the standalone Directus backup extension.
#
# Arms a restore WITHOUT Directus Studio — and even when Directus itself will
# not boot (e.g. a destroyed database). It writes the `.pending_restore` flag
# into the backup volume and restarts the Directus container; `restore.sh` then
# performs the restore on the next boot, BEFORE Directus starts, while the
# database has zero application connections.
#
# Because it never talks to the Directus API, it works whether the Directus
# container is running, stopped, or crash-looping: a throwaway helper container
# mounts the same volumes via `--volumes-from` to read the manifests and write
# the flag. No running Directus and no Docker socket inside the extension.
#
# Usage:
#   CONTAINER=myapp-directus-1 ./recover.sh                       # interactive picker
#   CONTAINER=myapp-directus-1 ./recover.sh 2026-02-20__14-30-00__manual
#
# Environment:
#   CONTAINER     Directus container name (prompted if missing)
#   BACKUP_DIR    Backup directory inside the container (default /directus/backups)
#   HELPER_IMAGE  Throwaway image providing `sh` (default: alpine)
#
# @author  Frank Kudermann – alphanull
# @license AGPL-3.0-only

set -e

CONTAINER="${CONTAINER:-}"
BACKUP_DIR="${BACKUP_DIR:-/directus/backups}"
HELPER_IMAGE="${HELPER_IMAGE:-alpine}"
BACKUP_ID="${1:-}"

command -v docker >/dev/null 2>&1 || { echo "docker not found in PATH"; exit 1; }

if [ -z "$CONTAINER" ]; then
    printf "Directus container name: "
    read -r CONTAINER
fi
[ -n "$CONTAINER" ] || { echo "CONTAINER is required."; exit 1; }

# ── List available backups (when no ID was passed) ────────────
# The helper mounts the Directus container's volumes without needing it to run.
if [ -z "$BACKUP_ID" ]; then
    echo "Reading backups from $CONTAINER:$BACKUP_DIR ..."
    LIST=$(docker run --rm -i --volumes-from "$CONTAINER" -e BACKUP_DIR="$BACKUP_DIR" "$HELPER_IMAGE" sh -s <<'HELPER'
for m in "$BACKUP_DIR"/*/backup.json; do
    [ -f "$m" ] || continue
    d=$(dirname "$m"); id=$(basename "$d")
    status=$(grep -o '"status"[^,]*' "$m" | head -1 | sed 's/.*: *"//;s/".*//')
    label=$(grep -o '"label"[^,]*' "$m" | head -1 | sed 's/.*: *"//;s/".*//')
    printf '%s\t%s\t%s\n' "$id" "${status:-?}" "${label:-?}"
done | sort -r
HELPER
)
    [ -n "$LIST" ] || { echo "No backups found in $BACKUP_DIR."; exit 1; }

    echo ""
    echo "Available backups:"
    echo ""
    i=1
    printf '%s\n' "$LIST" | while IFS="$(printf '\t')" read -r id status label; do
        printf "  [%d] %s  (%s, %s)\n" "$i" "$id" "$label" "$status"
        i=$((i + 1))
    done
    echo ""
    printf "Select backup number: "
    read -r CHOICE
    BACKUP_ID=$(printf '%s\n' "$LIST" | sed -n "${CHOICE}p" | cut -f1)
    [ -n "$BACKUP_ID" ] || { echo "Invalid selection."; exit 1; }
fi

# ── Validate BACKUP_ID ────────────────────────────────────────
# Reject anything outside the expected timestamp/slug charset before it
# reaches the flag file that restore.sh will source as shell code.
case "$BACKUP_ID" in
    *[!A-Za-z0-9_-]*) echo "Invalid BACKUP_ID (unexpected characters): $BACKUP_ID"; exit 1 ;;
esac

# ── Confirm ───────────────────────────────────────────────────
echo ""
echo "  Backup:    $BACKUP_ID"
echo "  Container: $CONTAINER"
echo ""
echo "  This restores the database (and any assets/extensions in the backup),"
echo "  then restarts Directus. Current data will be REPLACED."
echo ""
printf "Restore this backup? [y/N] "
read -r CONFIRM
case "$CONFIRM" in
    y | Y | yes | YES) ;;
    *) echo "Aborted."; exit 0 ;;
esac

# ── Arm the restore: write the flag into the backup volume ────
# Components are derived from the artefacts actually present in the backup, so a
# component is never "requested but missing" (which restore.sh treats as an
# error). DB credentials and CACHE_* are NOT written here — restore.sh reads
# those from the Directus container's own environment at boot.
echo ""
echo "Arming restore (writing $BACKUP_DIR/.pending_restore) ..."
RESULT=$(docker run --rm -i --volumes-from "$CONTAINER" \
    -e BACKUP_DIR="$BACKUP_DIR" -e BID="$BACKUP_ID" "$HELPER_IMAGE" sh -s <<'HELPER'
set -e
d="$BACKUP_DIR/$BID"
[ -d "$d" ] || { echo "NO_SUCH_BACKUP"; exit 0; }

inc_db=0
[ -f "$d/database.dump" ] && inc_db=1

inc_assets=0; [ -f "$d/uploads.tar.gz" ] && inc_assets=1
inc_ext=0;    [ -f "$d/extensions.tar.gz" ] && inc_ext=1

adapter=$(grep -o '"name"[^,}]*' "$d/backup.json" 2>/dev/null | head -1 | sed 's/.*: *"//;s/".*//')
[ -n "$adapter" ] || adapter=postgres

# Reject adapter values outside the safe identifier charset before they
# reach the flag file that restore.sh sources as shell code.
if [ -n "$(printf '%s' "$adapter" | tr -d 'A-Za-z0-9_-')" ]; then
    echo "INVALID_ADAPTER: $adapter"
    exit 0
fi

cat > "$BACKUP_DIR/.pending_restore" <<FLAG
BACKUP_ID="$BID"
BACKUP_PATH="$d"
DB_ADAPTER="$adapter"
RESTORE_INCLUDE_DB=$inc_db
RESTORE_INCLUDE_ASSETS=$inc_assets
RESTORE_INCLUDE_EXTENSIONS=$inc_ext
RESTORE_INCLUDE_TABLES=
FLAG

echo "ARMED db=$inc_db assets=$inc_assets extensions=$inc_ext"
HELPER
)

case "$RESULT" in
    *NO_SUCH_BACKUP*) echo "Backup '$BACKUP_ID' not found in $BACKUP_DIR."; exit 1 ;;
    *ARMED*) echo "  $RESULT" ;;
    *) echo "Failed to arm restore: $RESULT"; exit 1 ;;
esac

# ── Restart Directus → restore runs on boot, before Directus ──
echo ""
echo "Restarting $CONTAINER ..."
docker restart "$CONTAINER" >/dev/null

echo ""
echo "Restore armed and container restarted."
echo "It runs before Directus starts — monitor it with:"
echo "  docker logs -f $CONTAINER"
