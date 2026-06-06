#!/bin/sh
# Regression test for the PostgreSQL adapter's inclusion-based restore path.
#
# Verifies that:
#   - targeted restore (non-empty include list) calls DELETE + data-only pg_restore
#     with --disable-triggers so FK checks do not fire in the restore session
#   - a fatal pg_restore exit writes restore-error.txt and propagates the exit code
#   - a successful targeted restore exits 0 with no error file
#   - a psql failure during the DELETE phase aborts before pg_restore runs
#   - full restore (empty include list) still does schema reset + full pg_restore
#
# pg_restore / psql are replaced by mocks so exit codes can be forced
# deterministically — no PostgreSQL instance is required.
#
# Usage: sh test/adapters/postgres-restore.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ADAPTER="$SCRIPT_DIR/../../adapters/postgres.sh"

if [ ! -f "$ADAPTER" ]; then
  echo "Adapter not found: $ADAPTER"
  exit 1
fi

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ── Mocks ─────────────────────────────────────────────────────
# pg_restore: exits MOCK_PG_EXIT (default 0).
# psql:       exits MOCK_PSQL_EXIT (default 0).

MOCK_BIN="$WORK/bin"
mkdir -p "$MOCK_BIN"

cat > "$MOCK_BIN/pg_restore" <<'EOF'
#!/bin/sh
echo "pg_restore $*" >> "$MOCK_LOG"
exit "${MOCK_PG_EXIT:-0}"
EOF

cat > "$MOCK_BIN/psql" <<'EOF'
#!/bin/sh
# Only read stdin when called without -c (i.e. SQL is piped, not inline).
stdin=""
use_stdin=1
for arg in "$@"; do
  case "$arg" in -c*) use_stdin=0; break;; esac
done
[ "$use_stdin" -eq 1 ] && stdin=$(cat)
echo "psql $* $stdin" >> "$MOCK_LOG"
exit "${MOCK_PSQL_EXIT:-0}"
EOF

chmod +x "$MOCK_BIN"/pg_restore "$MOCK_BIN"/psql

export PATH="$MOCK_BIN:$PATH"
export DB_HOST=localhost DB_USER=u DB_PASSWORD=p DB_DATABASE=d

# ── Helpers ───────────────────────────────────────────────────

# Creates a fresh backup dir with a dummy custom-format dump.
new_backup_dir() {
  d="$WORK/backup"
  rm -rf "$d"
  mkdir -p "$d"
  echo "FAKE_DUMP_CONTENT" > "$d/database.dump"
  printf '%s' "$d"
}

# Runs db_restore with the given include list in a subshell with `set -e`.
# $1 = backup_path, $2 = include_tables (comma-separated, empty = full restore)
run_restore() {
  bp="$1"; inc="$2"
  sh -c '( set -e; . "$1"; db_init; db_restore "$2" custom "$3" )' \
    _ "$ADAPTER" "$bp" "$inc" > "$WORK/out.log" 2>&1
  return $?
}

# ── Case A: targeted restore, pg_restore fails fatally ────────

echo "Case A: targeted restore — pg_restore fails fatally"
BP=$(new_backup_dir)
export MOCK_LOG="$WORK/log_a"; : > "$MOCK_LOG"
MOCK_PG_EXIT=2 MOCK_PSQL_EXIT=0 run_restore "$BP" "analytics_events"
RC=$?
[ "$RC" -eq 2 ] && pass "exits with code 2" || fail "exit code $RC (expected 2)"
[ -f "$BP/restore-error.txt" ] && pass "restore-error.txt written" || fail "restore-error.txt missing"
grep -q "Targeted restore failed" "$BP/restore-error.txt" 2>/dev/null \
  && pass "error describes targeted-restore failure" || fail "wrong error message"
grep -q "\-\-data-only" "$MOCK_LOG" 2>/dev/null \
  && pass "pg_restore called with --data-only" || fail "pg_restore not called with --data-only"
grep -q "\-\-disable-triggers" "$MOCK_LOG" 2>/dev/null \
  && pass "pg_restore called with --disable-triggers" || fail "pg_restore missing --disable-triggers"

# ── Case B: targeted restore, pg_restore succeeds ─────────────

echo "Case B: targeted restore — success"
BP=$(new_backup_dir)
export MOCK_LOG="$WORK/log_b"; : > "$MOCK_LOG"
MOCK_PG_EXIT=0 MOCK_PSQL_EXIT=0 run_restore "$BP" "analytics_events"
RC=$?
[ "$RC" -eq 0 ] && pass "exits with code 0" || fail "exit code $RC (expected 0)"
[ ! -f "$BP/restore-error.txt" ] && pass "no restore-error.txt on success" || fail "unexpected restore-error.txt"
grep -q "\-\-data-only" "$MOCK_LOG" 2>/dev/null \
  && pass "pg_restore called with --data-only" || fail "pg_restore not called with --data-only"
grep -q "\-\-disable-triggers" "$MOCK_LOG" 2>/dev/null \
  && pass "pg_restore called with --disable-triggers" || fail "pg_restore missing --disable-triggers"
grep -q "DELETE FROM \"analytics_events\"" "$MOCK_LOG" 2>/dev/null \
  && pass "DELETE used in clear phase" || fail "DELETE not found in clear phase"
grep -q "DROP SCHEMA" "$MOCK_LOG" 2>/dev/null \
  && fail "schema was reset (should not be for targeted restore)" || pass "schema not reset for targeted restore"

# ── Case C: targeted restore, psql DELETE phase fails ───────

echo "Case C: targeted restore — psql DELETE fails"
BP=$(new_backup_dir)
export MOCK_LOG="$WORK/log_c"; : > "$MOCK_LOG"
MOCK_PG_EXIT=0 MOCK_PSQL_EXIT=2 run_restore "$BP" "analytics_events"
RC=$?
[ "$RC" -ne 0 ] && pass "aborts with non-zero exit ($RC)" || fail "did not abort (exit 0)"
grep -q "pg_restore" "$MOCK_LOG" 2>/dev/null \
  && fail "pg_restore called despite psql failure" || pass "pg_restore not reached after psql failure"

# ── Case D: full restore (empty include), pg_restore fails ────

echo "Case D: full restore (empty include) — pg_restore fails fatally"
BP=$(new_backup_dir)
export MOCK_LOG="$WORK/log_d"; : > "$MOCK_LOG"
MOCK_PG_EXIT=2 MOCK_PSQL_EXIT=0 run_restore "$BP" ""
RC=$?
[ "$RC" -eq 2 ] && pass "exits with code 2" || fail "exit code $RC (expected 2)"
grep -q "DROP SCHEMA" "$MOCK_LOG" 2>/dev/null \
  && pass "schema was reset (full restore path)" || fail "schema not reset in full restore path"

# ── Summary ───────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
