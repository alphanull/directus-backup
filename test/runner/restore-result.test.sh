#!/bin/sh
# Regression test for restore.sh accounting (restore-result.txt + markers).
#
# Verifies that a requested component whose file is absent aborts the restore
# hard (.restore_failed marker + restore-error.txt) instead of being silently
# skipped, that present components are recorded as "restored", and unrequested
# ones as "skipped". The import path guarantees scope/content consistency, so a
# missing requested component can only mean a manipulated/truncated backup —
# failing loudly is the correct behaviour.
#
# restore.sh is the boot-time restore: it consumes a `.pending_restore` flag from
# BACKUP_DIR, performs the restore, and always exits 0 after leaving a marker
# (.restore_done / .restore_failed) for the extension to reconcile. The test
# therefore arms a flag and asserts on the marker, not on the exit code.
#
# psql / pg_restore / tar are replaced by mocks on PATH so no database or real
# archives are required.
#
# Usage: sh test/runner/restore-result.test.sh

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

# Arms a `.pending_restore` flag and runs restore.sh in boot mode with the given
# include flags. Component archives are created beforehand by the caller. The
# flag directory (where the marker lands) is exposed via $FLAGDIR. CACHE_HOST is
# emptied to skip the Redis flush. DB_* come from the environment, as at boot.
run_restore() {
  bp="$1"; inc_db="$2"; inc_assets="$3"; inc_ext="$4"
  up="$WORK/uploads"; ext="$WORK/extensions"
  rm -rf "$up" "$ext"; mkdir -p "$up" "$ext"
  FLAGDIR="$WORK/flagdir"; rm -rf "$FLAGDIR"; mkdir -p "$FLAGDIR"
  cat > "$FLAGDIR/.pending_restore" <<EOF
BACKUP_ID=test
BACKUP_PATH=$bp
DB_ADAPTER=postgres
UPLOADS_DIR=$up
EXTENSIONS_DIR=$ext
RESTORE_INCLUDE_DB=$inc_db
RESTORE_INCLUDE_ASSETS=$inc_assets
RESTORE_INCLUDE_EXTENSIONS=$inc_ext
RESTORE_INCLUDE_TABLES=
EOF
  env PATH="$MOCK_BIN:$PATH" \
    DB_HOST=localhost DB_USER=u DB_PASSWORD=p DB_DATABASE=d \
    CACHE_HOST= \
    BACKUP_DIR="$FLAGDIR" \
    RUNNER_TIMEOUT_MIN=0 \
    sh "$RESTORESH" > "$WORK/out.log" 2>&1
  return $?
}

result_has()    { grep -qx "$2" "$1/restore-result.txt" 2>/dev/null; }
marker_done()   { [ -f "$FLAGDIR/.restore_done" ]; }
marker_failed() { [ -f "$FLAGDIR/.restore_failed" ]; }

# ── Case A: requested DB absent → hard fail, no silent skip ────

echo "Case A: a requested component whose file is absent aborts the restore"
BP="$WORK/backup_a"; rm -rf "$BP"; mkdir -p "$BP"
run_restore "$BP" 1 1 1
marker_failed && pass "marks .restore_failed (hard fail)" || fail "expected .restore_failed marker"
[ -f "$BP/restore-error.txt" ] && pass "restore-error.txt written" || fail "restore-error.txt missing"

# ── Case B: DB+assets present, extensions requested but absent ─

echo "Case B: present components restore, then an absent requested one aborts"
BP="$WORK/backup_b"; rm -rf "$BP"; mkdir -p "$BP"
echo "FAKE_DUMP" > "$BP/database.dump"
echo "FAKE_TGZ"  > "$BP/uploads.tar.gz"
run_restore "$BP" 1 1 1
marker_failed && pass "marks .restore_failed (extensions absent)" || fail "expected .restore_failed marker"
result_has "$BP" "db=restored"     && pass "db=restored recorded"     || fail "db not recorded restored"
result_has "$BP" "assets=restored" && pass "assets=restored recorded" || fail "assets not recorded restored"
[ -f "$BP/restore-error.txt" ] && pass "restore-error.txt written" || fail "restore-error.txt missing"

# ── Case C: unrequested components are "skipped" ──────────────

echo "Case C: unrequested components are recorded as skipped"
BP="$WORK/backup_c"; rm -rf "$BP"; mkdir -p "$BP"
echo "FAKE_DUMP" > "$BP/database.dump"
run_restore "$BP" 1 0 0
marker_done && pass "marks .restore_done" || fail "expected .restore_done marker"
result_has "$BP" "db=restored"         && pass "db=restored recorded"        || fail "db not recorded restored"
result_has "$BP" "assets=skipped"      && pass "assets=skipped recorded"     || fail "assets not recorded skipped"
result_has "$BP" "extensions=skipped"  && pass "extensions=skipped recorded" || fail "extensions not recorded skipped"

# ── Summary ───────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "--- last run output ---"; cat "$WORK/out.log"; exit 1; }
