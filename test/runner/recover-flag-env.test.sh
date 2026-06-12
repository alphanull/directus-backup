#!/bin/sh
# Regression test: recover.sh must not write default UPLOADS_DIR/EXTENSIONS_DIR
# into .pending_restore. restore.sh sources that flag with set -a, so values in
# the flag override the real Directus container environment at boot.
#
# Usage: sh test/runner/recover-flag-env.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RECOVERSH="$SCRIPT_DIR/../../scripts/recover.sh"

if [ ! -f "$RECOVERSH" ]; then
  echo "recover.sh not found under $SCRIPT_DIR/../../scripts"
  exit 1
fi

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

MOCK_BIN="$WORK/bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/docker" <<'EOF'
#!/bin/sh
case "$1" in
  run)
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -e)
          export "$2"
          shift 2
          ;;
        --rm|-i)
          shift
          ;;
        --volumes-from)
          shift 2
          ;;
        *)
          break
          ;;
      esac
    done
    # Remaining args are helper image + "sh -s"; execute the heredoc locally.
    shift
    exec "$@"
    ;;
  restart)
    echo "$2" > "$MOCK_RESTART_FILE"
    ;;
  *)
    echo "unexpected docker command: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$MOCK_BIN/docker"

BACKUP_DIR="$WORK/backups"
BACKUP_ID="2026-01-10__00-00-00__manual"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_ID"
mkdir -p "$BACKUP_PATH"
cat > "$BACKUP_PATH/backup.json" <<'EOF'
{
  "id": "2026-01-10__00-00-00__manual",
  "status": "success",
  "tool": { "name": "postgres" }
}
EOF
touch "$BACKUP_PATH/uploads.tar.gz" "$BACKUP_PATH/extensions.tar.gz"

echo "Recover CLI flag env"
if echo y | PATH="$MOCK_BIN:$PATH" \
  MOCK_RESTART_FILE="$WORK/restarted" \
  CONTAINER="directus-test-1" \
  BACKUP_DIR="$BACKUP_DIR" \
  HELPER_IMAGE="helper" \
  sh "$RECOVERSH" "$BACKUP_ID" > "$WORK/recover.log" 2>&1; then
  pass "recover.sh exits 0"
else
  fail "recover.sh exits non-zero"
fi

FLAG="$BACKUP_DIR/.pending_restore"
[ -f "$FLAG" ] && pass ".pending_restore written" || fail ".pending_restore missing"
[ "$(cat "$WORK/restarted" 2>/dev/null)" = "directus-test-1" ] && pass "container restart requested" || fail "container restart not requested"

if grep -q '^UPLOADS_DIR=' "$FLAG"; then
  fail "flag overrides UPLOADS_DIR"
else
  pass "flag does not override UPLOADS_DIR"
fi

if grep -q '^EXTENSIONS_DIR=' "$FLAG"; then
  fail "flag overrides EXTENSIONS_DIR"
else
  pass "flag does not override EXTENSIONS_DIR"
fi

grep -q '^RESTORE_INCLUDE_ASSETS=1$' "$FLAG" && pass "assets include derived from artefact" || fail "assets include not derived"
grep -q '^RESTORE_INCLUDE_EXTENSIONS=1$' "$FLAG" && pass "extensions include derived from artefact" || fail "extensions include not derived"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "--- recover log ---"; cat "$WORK/recover.log"; echo "--- flag ---"; cat "$FLAG" 2>/dev/null; exit 1; }
