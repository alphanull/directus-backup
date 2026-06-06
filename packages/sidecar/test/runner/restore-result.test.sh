#!/bin/sh
# Regression test for run.sh restore accounting (restore-result.txt).
#
# Verifies that a requested component whose file is absent aborts the restore
# hard (exit 1 + restore-error.txt) instead of being silently skipped, that
# present components are recorded as "restored", and unrequested ones as
# "skipped". The import path guarantees scope/content consistency, so a missing
# requested component can only mean a manipulated/truncated backup — failing
# loudly is the correct behaviour.
#
# psql / pg_restore / tar are replaced by mocks on PATH so no database or real
# archives are required.
#
# Usage: sh test/runner/restore-result.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RUNSH="$SCRIPT_DIR/../../run.sh"

if [ ! -f "$RUNSH" ]; then
  echo "run.sh not found: $RUNSH"
  exit 1
fi

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ── Mocks (only needed for the "restored" cases) ──────────────

MOCK_BIN="$WORK/bin"
mkdir -p "$MOCK_BIN"
for cmd in psql pg_restore pg_dump tar; do
  cat > "$MOCK_BIN/$cmd" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$MOCK_BIN/$cmd"
done

# Runs run.sh in restore mode with the given include flags. Component archives
# are created beforehand by the caller. Returns the exit code; output in out.log.
run_restore() {
  bp="$1"; inc_db="$2"; inc_assets="$3"; inc_ext="$4"
  up="$WORK/uploads"; ext="$WORK/extensions"
  rm -rf "$up" "$ext"; mkdir -p "$up" "$ext"
  env PATH="$MOCK_BIN:$PATH" \
    RUNNER_MODE=restore BACKUP_ID=test BACKUP_PATH="$bp" \
    DB_HOST=localhost DB_USER=u DB_PASSWORD=p DB_DATABASE=d \
    DB_ADAPTER=postgres BACKUP_DUMP_FORMAT=custom \
    RESTORE_INCLUDE_DB="$inc_db" RESTORE_INCLUDE_ASSETS="$inc_assets" RESTORE_INCLUDE_EXTENSIONS="$inc_ext" \
    UPLOADS_DIR="$up" EXTENSIONS_DIR="$ext" \
    sh "$RUNSH" > "$WORK/out.log" 2>&1
  return $?
}

result_has() { grep -qx "$2" "$1/restore-result.txt" 2>/dev/null; }

# ── Case A: requested DB absent → hard fail, no silent skip ────

echo "Case A: a requested component whose file is absent aborts the restore"
BP="$WORK/backup_a"; rm -rf "$BP"; mkdir -p "$BP"
run_restore "$BP" 1 1 1
RC=$?
[ "$RC" -ne 0 ] && pass "exits non-zero (hard fail)" || fail "exit code $RC (expected non-zero)"
[ -f "$BP/restore-error.txt" ] && pass "restore-error.txt written" || fail "restore-error.txt missing"

# ── Case B: DB+assets present, extensions requested but absent ─

echo "Case B: present components restore, then an absent requested one aborts"
BP="$WORK/backup_b"; rm -rf "$BP"; mkdir -p "$BP"
echo "FAKE_DUMP" > "$BP/database.dump"
echo "FAKE_TGZ"  > "$BP/uploads.tar.gz"
run_restore "$BP" 1 1 1
RC=$?
[ "$RC" -ne 0 ] && pass "exits non-zero (extensions absent)" || fail "exit code $RC (expected non-zero)"
result_has "$BP" "db=restored"     && pass "db=restored recorded"     || fail "db not recorded restored"
result_has "$BP" "assets=restored" && pass "assets=restored recorded" || fail "assets not recorded restored"
[ -f "$BP/restore-error.txt" ] && pass "restore-error.txt written" || fail "restore-error.txt missing"

# ── Case C: unrequested components are "skipped" ──────────────

echo "Case C: unrequested components are recorded as skipped"
BP="$WORK/backup_c"; rm -rf "$BP"; mkdir -p "$BP"
echo "FAKE_DUMP" > "$BP/database.dump"
run_restore "$BP" 1 0 0
RC=$?
[ "$RC" -eq 0 ] && pass "exits 0" || fail "exit code $RC (expected 0)"
result_has "$BP" "db=restored"         && pass "db=restored recorded"        || fail "db not recorded restored"
result_has "$BP" "assets=skipped"      && pass "assets=skipped recorded"     || fail "assets not recorded skipped"
result_has "$BP" "extensions=skipped"  && pass "extensions=skipped recorded" || fail "extensions not recorded skipped"

# ── Summary ───────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "--- last run output ---"; cat "$WORK/out.log"; exit 1; }
