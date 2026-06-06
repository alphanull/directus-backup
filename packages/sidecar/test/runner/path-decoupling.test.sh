#!/bin/sh
# Regression test for UPLOADS_DIR / EXTENSIONS_DIR path decoupling in run.sh.
#
# Earlier, the asset/extension tar steps hard-coded "-C /directus" (and the
# "uploads/"/"extensions/" member prefixes), so a non-standard UPLOADS_DIR or
# EXTENSIONS_DIR was either backed up from, or restored to, the wrong place.
#
# This test runs a real backup -> restore round-trip with non-standard paths
# (and a DIFFERENT basename on restore than on backup) and asserts that:
#   - the archive stores contents relative to the configured dir (no nesting),
#   - directus-health-file is excluded from the uploads archive,
#   - the selective extensions layout (.registry, package.json, dist) is kept
#     while non-selected files (e.g. src/) are not archived,
#   - restore lands the contents in the configured dir regardless of basename.
#
# Real `tar` is used (the whole point). Only `sha256sum` is mocked, because it
# is not present by default on macOS; the round-trip itself does not depend on
# checksum correctness.
#
# Usage: sh test/runner/path-decoupling.test.sh

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

# ── Mock sha256sum (macOS has no native sha256sum) ────────────
MOCK_BIN="$WORK/bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/sha256sum" <<'EOF'
#!/bin/sh
# -c (verify) always succeeds; otherwise emit a fixed digest per file so the
# backup's checksums.sha256 is well-formed.
if [ "$1" = "-c" ]; then exit 0; fi
for f in "$@"; do
  printf '0000000000000000000000000000000000000000000000000000000000000000  %s\n' "$f"
done
EOF
chmod +x "$MOCK_BIN/sha256sum"

# ── Source fixtures (basename "store" / "ext-src") ────────────
SRC_UP="$WORK/source/store"
SRC_EXT="$WORK/source/ext-src"
mkdir -p "$SRC_UP/sub" "$SRC_EXT/.registry" "$SRC_EXT/myext/dist" "$SRC_EXT/myext/src"
echo "hello"  > "$SRC_UP/file1.txt"
echo "nested" > "$SRC_UP/sub/file2.txt"
echo "HEALTH" > "$SRC_UP/directus-health-file"
echo "reg"    > "$SRC_EXT/.registry/reg1"
echo "{}"     > "$SRC_EXT/myext/package.json"
echo "code"   > "$SRC_EXT/myext/dist/index.js"
echo "src"    > "$SRC_EXT/myext/src/should-not-be-archived.js"

BP="$WORK/backup"
mkdir -p "$BP"

# ── Backup ────────────────────────────────────────────────────
echo "Backup: non-standard UPLOADS_DIR / EXTENSIONS_DIR"
env PATH="$MOCK_BIN:$PATH" \
  RUNNER_MODE=backup BACKUP_ID=test BACKUP_PATH="$BP" \
  DB_HOST=h DB_USER=u DB_PASSWORD=p DB_DATABASE=d \
  DB_ADAPTER=postgres BACKUP_DUMP_FORMAT=custom \
  BACKUP_INCLUDE_DB=0 BACKUP_INCLUDE_ASSETS=1 BACKUP_INCLUDE_EXTENSIONS=1 \
  UPLOADS_DIR="$SRC_UP" EXTENSIONS_DIR="$SRC_EXT" \
  sh "$RUNSH" > "$WORK/backup.log" 2>&1
RC=$?
[ "$RC" -eq 0 ] && pass "backup exits 0" || fail "backup exit code $RC"
[ -f "$BP/uploads.tar.gz" ]    && pass "uploads.tar.gz created"    || fail "uploads.tar.gz missing"
[ -f "$BP/extensions.tar.gz" ] && pass "extensions.tar.gz created" || fail "extensions.tar.gz missing"

# Archive member names must be relative to the configured dir (no basename
# prefix, no /directus), so a different restore target works.
UP_LIST=$(tar tzf "$BP/uploads.tar.gz")
echo "$UP_LIST" | grep -q "store/"  && fail "uploads archive contains 'store/' prefix" || pass "uploads archive has no basename prefix"
echo "$UP_LIST" | grep -q "file1.txt"            && pass "uploads archive contains file1.txt" || fail "uploads archive missing file1.txt"
echo "$UP_LIST" | grep -q "directus-health-file" && fail "directus-health-file was archived" || pass "directus-health-file excluded"

EXT_LISTING=$(tar tzf "$BP/extensions.tar.gz")
echo "$EXT_LISTING" | grep -q "ext-src/" && fail "extensions archive contains 'ext-src/' prefix" || pass "extensions archive has no basename prefix"
echo "$EXT_LISTING" | grep -q "should-not-be-archived" && fail "non-selected src/ file was archived" || pass "non-selected extension files excluded"

# ── Restore into DIFFERENT dirs (different basename) ──────────
echo "Restore: into a different basename to prove decoupling"
DST_UP="$WORK/target/assets"
DST_EXT="$WORK/target/ext-dst"
mkdir -p "$DST_UP" "$DST_EXT"

# Plant a stale dotfile that must not survive the restore.
echo "stale" > "$DST_UP/.stale-dotfile"

env PATH="$MOCK_BIN:$PATH" \
  RUNNER_MODE=restore BACKUP_ID=test BACKUP_PATH="$BP" \
  DB_HOST=h DB_USER=u DB_PASSWORD=p DB_DATABASE=d \
  DB_ADAPTER=postgres BACKUP_DUMP_FORMAT=custom \
  RESTORE_INCLUDE_DB=0 RESTORE_INCLUDE_ASSETS=1 RESTORE_INCLUDE_EXTENSIONS=1 \
  UPLOADS_DIR="$DST_UP" EXTENSIONS_DIR="$DST_EXT" \
  sh "$RUNSH" > "$WORK/restore.log" 2>&1
RC=$?
[ "$RC" -eq 0 ] && pass "restore exits 0" || fail "restore exit code $RC"

# Uploads landed directly in DST_UP (no nesting), health-file absent.
[ -f "$DST_UP/file1.txt" ]      && pass "uploads file1.txt restored into UPLOADS_DIR" || fail "file1.txt missing in UPLOADS_DIR"
[ -f "$DST_UP/sub/file2.txt" ]  && pass "uploads sub/file2.txt restored"              || fail "sub/file2.txt missing"
[ ! -e "$DST_UP/store" ]        && pass "no 'store/' nesting in UPLOADS_DIR"          || fail "uploads nested under 'store/'"
[ ! -e "$DST_UP/uploads" ]      && pass "no 'uploads/' nesting in UPLOADS_DIR"        || fail "uploads nested under 'uploads/'"
[ ! -e "$DST_UP/directus-health-file" ] && pass "health-file not restored"           || fail "health-file restored"
[ ! -e "$DST_UP/.stale-dotfile" ]      && pass "stale dotfile removed on restore"    || fail "stale dotfile survived restore"

# Extensions landed directly in DST_EXT with the selective layout.
[ -f "$DST_EXT/.registry/reg1" ]       && pass ".registry/reg1 restored"        || fail ".registry/reg1 missing"
[ -f "$DST_EXT/myext/package.json" ]   && pass "myext/package.json restored"    || fail "myext/package.json missing"
[ -f "$DST_EXT/myext/dist/index.js" ]  && pass "myext/dist/index.js restored"   || fail "myext/dist/index.js missing"
[ ! -e "$DST_EXT/myext/src" ]          && pass "non-selected src/ not restored" || fail "src/ was restored"
[ ! -e "$DST_EXT/ext-src" ]            && pass "no 'ext-src/' nesting"          || fail "extensions nested under 'ext-src/'"

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "--- backup log ---"; cat "$WORK/backup.log"; echo "--- restore log ---"; cat "$WORK/restore.log"; exit 1; }
