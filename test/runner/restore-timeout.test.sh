#!/bin/sh
# Regression test for the restore.sh wall-clock watchdog.
#
# A boot-time restore has no external supervisor, so a hung pg_restore/psql/tar
# would block the container boot indefinitely AND keep mutating the database
# while Directus starts. restore.sh therefore runs the restore body under a
# watchdog that, on timeout, terminates the WHOLE process group (TERM, then KILL
# after a grace period). This test proves:
#   1. a hung runner is aborted (.restore_failed + restore-error.txt),
#   2. the whole tree is killed (the grandchild `pg_restore` does NOT survive).
#
# The watchdog needs `setsid` for the process-group kill. Hosts without it must
# fail closed before the restore body runs. Hosts with it exercise the real group
# kill. RUNNER_TIMEOUT_SEC lets the watchdog fire in seconds instead of minutes.
#
# Usage: sh test/runner/restore-timeout.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RESTORESH="$SCRIPT_DIR/../../scripts/restore.sh"

if [ ! -f "$RESTORESH" ]; then
  echo "restore.sh not found: $RESTORESH"
  exit 1
fi

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; [ -f "$WORK/pg.pid" ] && kill -KILL "$(cat "$WORK/pg.pid")" 2>/dev/null' EXIT

# ── Mocks ─────────────────────────────────────────────────────
# psql/tar/pg_dump succeed instantly; pg_restore simulates a hang by replacing
# itself with `sleep` (via exec, so its PID == the recorded PID). The watchdog
# must kill this grandchild when it fires.
MOCK_BIN="$WORK/bin"
mkdir -p "$MOCK_BIN"
for cmd in psql pg_dump tar; do
  cat > "$MOCK_BIN/$cmd" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$MOCK_BIN/$cmd"
done
cat > "$MOCK_BIN/pg_restore" <<EOF
#!/bin/sh
echo \$\$ > "$WORK/pg.pid"
exec sleep 300
EOF
chmod +x "$MOCK_BIN/pg_restore"

if ! command -v setsid >/dev/null 2>&1; then
  BP="$WORK/no-setsid-backup"; mkdir -p "$BP"
  up="$WORK/no-setsid-uploads"; ext="$WORK/no-setsid-extensions"; mkdir -p "$up" "$ext"
  FLAGDIR="$WORK/no-setsid-flagdir"; mkdir -p "$FLAGDIR"
  cat > "$FLAGDIR/.pending_restore" <<EOF
BACKUP_ID=test
BACKUP_PATH=$BP
DB_ADAPTER=postgres
UPLOADS_DIR=$up
EXTENSIONS_DIR=$ext
RESTORE_INCLUDE_DB=0
RESTORE_INCLUDE_ASSETS=0
RESTORE_INCLUDE_EXTENSIONS=0
RESTORE_INCLUDE_TABLES=
EOF

  echo "Case: active timeout fails closed when setsid is unavailable"
  env PATH="$MOCK_BIN:$PATH" \
    DB_HOST=localhost DB_USER=u DB_PASSWORD=p DB_DATABASE=d \
    CACHE_HOST= \
    BACKUP_DIR="$FLAGDIR" \
    RUNNER_TIMEOUT_SEC=2 \
    sh "$RESTORESH" > "$WORK/no-setsid.log" 2>&1

  [ -f "$FLAGDIR/.restore_failed" ] && pass "marks .restore_failed when setsid is missing" || fail "expected .restore_failed marker"
  grep -q "setsid' is unavailable" "$BP/restore-error.txt" 2>/dev/null \
    && pass "restore-error.txt explains missing setsid" || fail "missing/wrong setsid restore-error.txt"
  [ ! -f "$BP/restore-result.txt" ] && pass "restore body did not run without setsid" || fail "restore body ran without watchdog"

  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ] || { echo "--- run output ---"; cat "$WORK/no-setsid.log"; exit 1; }
  exit 0
fi

# ── Arm + run a restore with a 2-second budget against a hung pg_restore ──
BP="$WORK/backup"; mkdir -p "$BP"
echo "FAKE_DUMP" > "$BP/database.dump"
up="$WORK/uploads"; ext="$WORK/extensions"; mkdir -p "$up" "$ext"
FLAGDIR="$WORK/flagdir"; mkdir -p "$FLAGDIR"
cat > "$FLAGDIR/.pending_restore" <<EOF
BACKUP_ID=test
BACKUP_PATH=$BP
DB_ADAPTER=postgres
UPLOADS_DIR=$up
EXTENSIONS_DIR=$ext
RESTORE_INCLUDE_DB=1
RESTORE_INCLUDE_ASSETS=0
RESTORE_INCLUDE_EXTENSIONS=0
RESTORE_INCLUDE_TABLES=
EOF

echo "Case: a hung restore is aborted by the watchdog and its process tree killed"
START=$(date +%s)
env PATH="$MOCK_BIN:$PATH" \
  DB_HOST=localhost DB_USER=u DB_PASSWORD=p DB_DATABASE=d \
  CACHE_HOST= \
  BACKUP_DIR="$FLAGDIR" \
  RUNNER_TIMEOUT_SEC=2 \
  sh "$RESTORESH" > "$WORK/out.log" 2>&1
ELAPSED=$(( $(date +%s) - START ))

[ -f "$FLAGDIR/.restore_failed" ] && pass "marks .restore_failed on timeout" || fail "expected .restore_failed marker"
grep -q "exceeded the runner timeout" "$BP/restore-error.txt" 2>/dev/null \
  && pass "restore-error.txt records the timeout" || fail "restore-error.txt missing/wrong"

# The hung grandchild must be gone (group kill, not just the direct child).
if [ -f "$WORK/pg.pid" ]; then
  PG_PID=$(cat "$WORK/pg.pid")
  if kill -0 "$PG_PID" 2>/dev/null; then
    fail "hung pg_restore ($PG_PID) survived the watchdog"
    kill -KILL "$PG_PID" 2>/dev/null
  else
    pass "hung pg_restore process tree was terminated"
  fi
else
  fail "mock pg_restore did not run (no pid recorded)"
fi

# Should return promptly (budget + a little), not after the full sleep.
[ "$ELAPSED" -lt 30 ] && pass "returned promptly (${ELAPSED}s)" || fail "took too long (${ELAPSED}s)"

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "--- run output ---"; cat "$WORK/out.log"; exit 1; }
