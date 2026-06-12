#!/usr/bin/env bash
set -euo pipefail

# Integration test for the standalone backup extension.
#
# Spins up Directus + PostgreSQL + Redis with the extension mounted, then drives
# the full lifecycle through the Directus API: create -> verify -> restore
# (in-container, via container restart) -> download -> import round-trip,
# large-upload bypass of MAX_PAYLOAD_SIZE (application/gzip), restore-timeout
# watchdog, disaster recovery, and tears down.
#
# Unlike the sidecar test, the restore runs inside the Directus container: the
# extension arms it and signals PID 1, the `restart: unless-stopped` policy
# brings the container back, and the entrypoint runs restore.sh before Directus
# starts. Success is asserted from the Directus logs and the reconciled
# manifest — there is no separate backup service.
#
# Usage: npm run test:integration   (or: bash test/integration/run.sh)
# Requires: docker compose, curl, jq, node/npm (to build the extension)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
# BASE_URL / API are set once the stack is up and the ephemeral host port for
# Directus is known (see "discover mapped port" below).
BASE_URL=""
API=""

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

cleanup() {
    echo "Tearing down..."
    cd "$SCRIPT_DIR"
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f "$ENV_FILE"
    # Remove the transient test-only slow adapter (see the timeout scenario).
    rm -f "$PKG_DIR/scripts/adapters/_ittimeout.sh"
}
trap cleanup EXIT

# ── Build the extension (dist/ is what the container mounts) ──────

echo "Building extension..."
(cd "$PKG_DIR" && npm run build >/dev/null 2>&1)
[ -f "$PKG_DIR/dist/api.js" ] && [ -f "$PKG_DIR/dist/app.js" ] \
    || { echo "Extension build did not produce dist/api.js + dist/app.js"; exit 1; }

# ── Setup ────────────────────────────────────────────────────────

echo "Setting up integration test..."
cat > "$ENV_FILE" <<EOF
DIRECTUS_SECRET=$(openssl rand -hex 32)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=testpassword123
DB_USER=directus
DB_PASSWORD=$(openssl rand -hex 16)
DB_DATABASE=directus
EOF

cd "$SCRIPT_DIR"
echo "Building Directus image..."
docker compose build directus --quiet 2>&1

echo "Starting stack..."
docker compose up -d --wait --wait-timeout 180 2>&1

echo "Waiting for services to stabilize..."
sleep 5

# ── Discover the mapped (ephemeral) Directus host port ───────────

HOST_HP=$(docker compose port directus 8055 2>/dev/null) || true
HOST_PORT="${HOST_HP##*:}"
if [ -z "$HOST_PORT" ]; then
    echo "Could not determine the mapped Directus host port"
    docker compose ps 2>&1
    exit 1
fi
BASE_URL="http://localhost:$HOST_PORT"
API="$BASE_URL/backup-api"
echo "Directus reachable at $BASE_URL"

# ── Helpers ──────────────────────────────────────────────────────

login() {
    curl -s -m 10 -X POST "$BASE_URL/auth/login" \
        -H "Content-Type: application/json" \
        -d '{"email":"admin@example.com","password":"testpassword123"}' \
        | jq -r '.data.access_token // empty' 2>/dev/null || true
}

wait_ping() {
    max="${1:-60}"
    i=0
    while [ "$i" -lt "$max" ]; do
        [ "$(curl -s -m 5 "$BASE_URL/server/ping" 2>/dev/null)" = "pong" ] && { echo "    ...Directus responded after $((i * 2))s"; return 0; }
        i=$((i + 1))
        [ $((i % 5)) -eq 0 ] && echo "    ...still waiting for Directus ($((i * 2))s elapsed)"
        sleep 2
    done
    return 1
}

echo ""
echo "Running tests..."

# ── Auth token ───────────────────────────────────────────────────

TOKEN=""
for _ in $(seq 1 10); do
    TOKEN=$(login)
    [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && break
    sleep 3
done
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    fail "Could not obtain auth token"
    docker compose logs directus --tail 30 2>&1
    exit 1
fi
pass "Auth token obtained"

# ── Extension loaded + access ─────────────────────────────────────

ACCESS=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/check-access" | jq -r '.access // empty' 2>/dev/null) || true
if [ "$ACCESS" = "true" ]; then
    pass "Extension loaded and accessible"
else
    fail "Extension not loaded or not accessible: $ACCESS"
fi

HEALTH=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/health" 2>/dev/null) || true
HEALTH_OK=$(echo "$HEALTH" | jq -r '.ok // empty' 2>/dev/null) || true
HEALTH_OP=$(echo "$HEALTH" | jq -r '.operational // empty' 2>/dev/null) || true
HEALTH_RR=$(echo "$HEALTH" | jq -r '.restoreReady // empty' 2>/dev/null) || true
[ "$HEALTH_OK" = "true" ] && pass "Installation health: ok" || fail "Installation health not ok: $HEALTH"
[ "$HEALTH_OP" = "true" ] && pass "Installation health: operational" || fail "Installation not operational: $HEALTH"
[ "$HEALTH_RR" = "true" ] && pass "Installation health: restore ready" || fail "Installation not restore-ready: $HEALTH"

# ── Create backup ────────────────────────────────────────────────

CREATE_RESPONSE=$(curl -s -m 30 -X POST -H "Authorization: Bearer $TOKEN" "$API/create") || true
BACKUP_ID=$(echo "$CREATE_RESPONSE" | jq -r '.id // empty' 2>/dev/null) || true
if [ -n "$BACKUP_ID" ] && [ "$BACKUP_ID" != "null" ]; then
    pass "Backup created: $BACKUP_ID"
else
    fail "Backup creation failed: $CREATE_RESPONSE"
fi

    echo "  Waiting for backup to complete..."
STATUS=""
for i in $(seq 1 60); do
    sleep 1
    STATUS=$(curl -s -m 10 -H "Authorization: Bearer $TOKEN" "$API/list" | jq -r ".[0].status // empty" 2>/dev/null) || true
    [ "$STATUS" = "success" ] && break
    [ $((i % 10)) -eq 0 ] && echo "    ...still waiting for backup (${i}s elapsed, status: ${STATUS:-pending})"
done
[ "$STATUS" = "success" ] && pass "Backup status: success" || fail "Backup status: $STATUS (expected success)"

# ── Verify backup content ────────────────────────────────────────

TABLES=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/list" | jq '.[0].verify.dumpTables // 0' 2>/dev/null) || true
[ "${TABLES:-0}" -gt 0 ] 2>/dev/null && pass "Backup contains $TABLES tables" || fail "Backup has no tables"

COLLECTIONS=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/list" | jq '.[0].scope.collections | length // 0' 2>/dev/null) || true
[ "${COLLECTIONS:-0}" -gt 0 ] 2>/dev/null \
    && pass "Backup manifest has positive collection index ($COLLECTIONS collections)" \
    || fail "Backup manifest missing positive collection index"

# ── Restore (in-container, via container restart) ────────────────

RESTORE=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/$BACKUP_ID/restore" | jq -r '.accepted // empty' 2>/dev/null) || true
[ "$RESTORE" = "true" ] && pass "Restore accepted" || fail "Restore not accepted"

echo "  Waiting for the container to restart and run the restore..."
RESTORE_LOGGED=0
for i in $(seq 1 60); do
    sleep 2
    if docker compose logs directus 2>&1 | grep -F "Restore complete (marker: .restore_done)" >/dev/null; then
        RESTORE_LOGGED=1
        break
    fi
    [ $((i % 5)) -eq 0 ] && echo "    ...still waiting for restore.sh ($((i * 2))s elapsed)"
done
[ "$RESTORE_LOGGED" -eq 1 ] \
    && pass "restore.sh completed (marker: .restore_done)" \
    || fail "restore.sh did not report completion"

# The restore restarts the container (SIGTERM to PID 1 + restart policy). A
# container published on an ephemeral host port gets a NEW host port after a
# restart, so the pre-restart BASE_URL is now dead — re-discover the mapping.
echo "  Re-discovering Directus host port (changes across the restart)..."
NEW_PORT=""
for _ in $(seq 1 30); do
    HP=$(docker compose port directus 8055 2>/dev/null) || true
    NEW_PORT="${HP##*:}"
    [ -n "$NEW_PORT" ] && break
    sleep 2
done
if [ -n "$NEW_PORT" ]; then
    [ "$NEW_PORT" != "$HOST_PORT" ] && echo "  Host port changed: $HOST_PORT -> $NEW_PORT"
    HOST_PORT="$NEW_PORT"
    BASE_URL="http://localhost:$HOST_PORT"
    API="$BASE_URL/backup-api"
fi

echo "  Waiting for Directus to come back up..."
if wait_ping 60; then
    pass "Directus healthy after restore"
else
    fail "Directus not responding after restore"
fi

# Token was invalidated by the restart + DB restore; re-authenticate.
TOKEN=""
for _ in $(seq 1 10); do
    TOKEN=$(login)
    [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && break
    sleep 3
done
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && pass "Re-authenticated after restore" || fail "Could not re-authenticate after restore"

# ── Restore status reconciled into the manifest ──────────────────

LIST_AFTER=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/list" 2>/dev/null) || true

RESTORE_STATUS=$(echo "$LIST_AFTER" | jq -r '.[0].restoreStatus // empty' 2>/dev/null) || true
[ "$RESTORE_STATUS" = "success" ] \
    && pass "Restore status in manifest: success" \
    || fail "Restore status in manifest: \"$RESTORE_STATUS\" (expected success)"

RESTORE_DB=$(echo "$LIST_AFTER" | jq -r '.[0].restore.database // empty' 2>/dev/null) || true
[ "$RESTORE_DB" = "restored" ] \
    && pass "Restore component database=restored" \
    || fail "Restore component database: \"$RESTORE_DB\" (expected restored)"

# ── Download backup ───────────────────────────────────────────────

DOWNLOAD_TMP=$(mktemp)
DL_CODE=$(curl -s -o "$DOWNLOAD_TMP" -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" "$API/$BACKUP_ID/download") || true
if [ "$DL_CODE" = "200" ] && [ -s "$DOWNLOAD_TMP" ]; then
    pass "Backup downloaded ($(wc -c < "$DOWNLOAD_TMP" | tr -d ' ') bytes)"
else
    fail "Backup download failed: HTTP $DL_CODE"
fi

# ── Re-import same backup (duplicate → 409) ───────────────────────

REIMPORT1=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
    --data-binary "@$DOWNLOAD_TMP" "$API/upload") || true
[ "$REIMPORT1" = "409" ] \
    && pass "Re-import of existing backup rejected with 409" \
    || fail "Re-import (duplicate): expected 409, got $REIMPORT1"

# ── Delete + re-import (download → delete → upload round-trip) ────

curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$API/$BACKUP_ID" >/dev/null 2>&1 || true

REIMPORT2=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
    --data-binary "@$DOWNLOAD_TMP" "$API/upload") || true
[ "$REIMPORT2" = "200" ] \
    && pass "Re-import after delete: 200" \
    || fail "Re-import after delete: expected 200, got $REIMPORT2"

rm -f "$DOWNLOAD_TMP"

# ── Import hardening: inconsistent archive rejected (400) ─────────

INC_DIR=$(mktemp -d)
INC_ID="2000-01-01__00-00-00__test-import"
mkdir -p "$INC_DIR/$INC_ID"
printf '{"id":"%s","status":"success","scope":{"database":true,"assets":true,"extensions":false}}' \
    "$INC_ID" > "$INC_DIR/$INC_ID/backup.json"
echo "FAKE_DUMP" > "$INC_DIR/$INC_ID/database.dump"
# uploads.tar.gz intentionally absent (scope/content inconsistency).
tar czf "$INC_DIR/inconsistent.tar.gz" -C "$INC_DIR" "$INC_ID"

INC_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
    --data-binary "@$INC_DIR/inconsistent.tar.gz" "$API/upload") || true
[ "$INC_STATUS" = "400" ] \
    && pass "Import hardening: inconsistent archive rejected (400)" \
    || fail "Import hardening: expected 400, got $INC_STATUS"

rm -rf "$INC_DIR"

# ── Import hardening: hard-link archive rejected (400) ───────────
# Verifies the hard-link type check against the production (Alpine/BusyBox) tar
# listing format — the format the parser actually sees in deployment.

HL_DIR=$(mktemp -d)
HL_ID="2000-01-02__00-00-00__test-hardlink"
mkdir -p "$HL_DIR/$HL_ID"
printf '{"id":"%s","status":"success","scope":{"database":true,"assets":false,"extensions":false}}' \
    "$HL_ID" > "$HL_DIR/$HL_ID/backup.json"
echo "FAKE_DUMP" > "$HL_DIR/$HL_ID/database.dump"
ln "$HL_DIR/$HL_ID/database.dump" "$HL_DIR/$HL_ID/hardlink.dump"
COPYFILE_DISABLE=1 tar czf "$HL_DIR/hardlink.tar.gz" -C "$HL_DIR" "$HL_ID"

HL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
    --data-binary "@$HL_DIR/hardlink.tar.gz" "$API/upload") || true
[ "$HL_STATUS" = "400" ] \
    && pass "Import hardening: hard-link archive rejected (400)" \
    || fail "Import hardening: expected 400 for hard link, got $HL_STATUS"

rm -rf "$HL_DIR"

# ── Import: large gzip upload bypasses Directus MAX_PAYLOAD_SIZE ──
# handleImport streams the raw body to disk; security.md claims application/gzip
# bypasses express.json(). With MAX_PAYLOAD_SIZE=1mb in compose, a >1MB archive
# must reach our handler (200) while the same bytes as application/json must not.

echo ""
echo "  Large upload: building a >1MB valid archive..."
LG_DIR=$(mktemp -d)
LG_ID="2000-01-03__00-00-00__test-large"
mkdir -p "$LG_DIR/$LG_ID"
printf '{"id":"%s","status":"success","scope":{"database":true,"assets":false,"extensions":false}}' \
    "$LG_ID" > "$LG_DIR/$LG_ID/backup.json"
dd if=/dev/urandom of="$LG_DIR/$LG_ID/database.dump" bs=1M count=2 2>/dev/null
# macOS tar injects AppleDouble (._*) entries that break the single-directory check.
COPYFILE_DISABLE=1 tar czf "$LG_DIR/large.tar.gz" -C "$LG_DIR" "$LG_ID"
LG_SIZE=$(wc -c < "$LG_DIR/large.tar.gz" | tr -d ' ')

if [ "${LG_SIZE:-0}" -le 1048576 ]; then
    fail "Large-upload fixture too small (${LG_SIZE:-0} bytes; need >1MB)"
else
    pass "Large-upload fixture ready (${LG_SIZE} bytes compressed)"
fi

LG_RESP="$LG_DIR/resp.json"
LG_STATUS=$(curl -s -o "$LG_RESP" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
    --data-binary "@$LG_DIR/large.tar.gz" "$API/upload") || true
if [ "$LG_STATUS" = "200" ]; then
    pass "Large gzip upload accepted (HTTP 200; bypasses MAX_PAYLOAD_SIZE=1mb)"
    curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$API/$LG_ID" >/dev/null 2>&1 || true
elif [ "$LG_STATUS" = "413" ]; then
    fail "Large gzip upload rejected with 413 — Directus buffered/limited the body"
else
    fail "Large gzip upload: expected 200, got $LG_STATUS ($(tr -d '\n' < "$LG_RESP" 2>/dev/null))"
fi

JSON_RESP="$LG_DIR/json-resp.json"
JSON_STATUS=$(curl -s -o "$JSON_RESP" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data-binary "@$LG_DIR/large.tar.gz" "$API/upload") || true
case "$JSON_STATUS" in
    413) pass "JSON control: MAX_PAYLOAD_SIZE enforced (413)" ;;
    400)
        if grep -qi 'too large\|payload' "$JSON_RESP" 2>/dev/null; then
            pass "JSON control: oversized body rejected (400 payload error)"
        else
            fail "JSON control: 400 but not a payload-size error ($(tr -d '\n' < "$JSON_RESP" 2>/dev/null))"
        fi
        ;;
    *)
        fail "JSON control: expected 413/400 payload rejection, got $JSON_STATUS"
        ;;
esac

rm -rf "$LG_DIR"

# ── Restore timeout: hung runner aborted, boot not wedged, reconciled failed ──
# A boot-time restore has no external supervisor, so restore.sh runs the restore
# body under a wall-clock watchdog (RUNNER_TIMEOUT_*) that kills the WHOLE process
# group on timeout. The runner test proves the group-kill against the real image;
# this proves the end-to-end path nothing else covers: entrypoint -> watchdog ->
# Directus still boots -> manifest reconciled as FAILED with the timeout reason.
#
# A hang is injected via a deliberately slow DB adapter dropped on the HOST under
# scripts/adapters/ — visible in the container through the (live) read-only mount,
# since :ro only blocks writes FROM the container. The mock never touches the DB,
# so this scenario is non-destructive and leaves the restored state intact.

echo ""
echo "  Restore timeout: injecting a hung adapter with a short budget..."
MOCK_ADAPTER="$PKG_DIR/scripts/adapters/_ittimeout.sh"
cat > "$MOCK_ADAPTER" <<'EOF'
# Test-only adapter: simulates a hung restore so the watchdog can abort it.
# Sourced by restore.sh in place of postgres.sh when DB_ADAPTER=_ittimeout.
db_init() { :; }
db_backup() { :; }
db_counts() { :; }
db_dump_table_count() { echo 0; }
db_dump_table_list() { :; }
db_restore() { echo "[itmock] slow restore — sleeping"; sleep 600; }
EOF

# Arm a restore directly on the backup volume (bypasses the API on purpose: we
# need a controlled hang, not a real DB restore). RUNNER_TIMEOUT_SEC lets the
# watchdog fire in seconds; it is sourced from the flag and exported by restore.sh.
if docker compose exec -T directus sh -c "cat > /directus/backups/.pending_restore <<FLAG
BACKUP_ID=$BACKUP_ID
BACKUP_PATH=/directus/backups/$BACKUP_ID
DB_ADAPTER=_ittimeout
UPLOADS_DIR=/directus/uploads
EXTENSIONS_DIR=/directus/extensions
RESTORE_INCLUDE_DB=1
RESTORE_INCLUDE_ASSETS=0
RESTORE_INCLUDE_EXTENSIONS=0
RESTORE_INCLUDE_TABLES=
RUNNER_TIMEOUT_SEC=3
FLAG
"; then
    pass "Armed a hung restore (slow adapter, 3s budget)"
else
    fail "Could not arm the timeout restore"
fi

docker compose restart directus >/dev/null 2>&1 || true

# Gate on restore.sh's final marker line (emitted by the main shell, the same
# signal the success path waits on). The watchdog's own "Timeout after …" line is
# emitted from a backgrounded sub-shell and is not a reliable completion gate.
echo "  Waiting for restore.sh to abort the hung restore..."
RESTORE_FAILED_LOGGED=0
for i in $(seq 1 60); do
    sleep 2
    if docker compose logs directus 2>&1 | grep -F "Restore failed (marker: .restore_failed)" >/dev/null; then
        RESTORE_FAILED_LOGGED=1
        break
    fi
    [ $((i % 5)) -eq 0 ] && echo "    ...still waiting for the watchdog ($((i * 2))s elapsed)"
done
[ "$RESTORE_FAILED_LOGGED" -eq 1 ] \
    && pass "Watchdog aborted the hung restore (marker: .restore_failed)" \
    || fail "restore.sh did not report a failed restore"

rm -f "$MOCK_ADAPTER"

echo "  Re-discovering host port + waiting for boot after the timeout..."
NEW_PORT=""
for _ in $(seq 1 30); do
    HP=$(docker compose port directus 8055 2>/dev/null) || true
    NEW_PORT="${HP##*:}"
    [ -n "$NEW_PORT" ] && break
    sleep 2
done
if [ -n "$NEW_PORT" ]; then
    HOST_PORT="$NEW_PORT"
    BASE_URL="http://localhost:$HOST_PORT"
    API="$BASE_URL/backup-api"
fi

if wait_ping 60; then
    pass "Directus booted despite the timed-out restore (boot not wedged)"
else
    fail "Directus did not come up after the timed-out restore"
fi

TOKEN=""
for _ in $(seq 1 10); do
    TOKEN=$(login)
    [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && break
    sleep 3
done

TLIST=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/list" 2>/dev/null) || true
TRS=$(echo "$TLIST" | jq -r --arg id "$BACKUP_ID" '.[] | select(.id==$id) | .restoreStatus // empty' 2>/dev/null) || true
[ "$TRS" = "failed" ] \
    && pass "Timed-out restore reconciled as failed" \
    || fail "Restore status after timeout: \"$TRS\" (expected failed)"

TRE=$(echo "$TLIST" | jq -r --arg id "$BACKUP_ID" '.[] | select(.id==$id) | .restoreError // empty' 2>/dev/null) || true
case "$TRE" in
    *"exceeded the runner timeout"*) pass "Manifest records the timeout reason" ;;
    *) fail "restoreError did not record the timeout: \"$TRE\"" ;;
esac

# ── Disaster recovery: destroy the DB, restore via CLI (no Studio) ──
# Proves scripts/recover.sh recovers a system whose database is gone and whose
# Directus can no longer serve — without the API, using only the backup volume.
# (The delete + re-import round-trip above left BACKUP_ID present on disk again.)

DB_PASSWORD=$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)

echo "  Disaster: dropping the database schema..."
DROP_LOG=$(mktemp)
if docker compose exec -T -e PGPASSWORD="$DB_PASSWORD" database \
    psql -U directus -d directus -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >"$DROP_LOG" 2>&1; then
    echo "    schema dropped"
else
    fail "Database schema drop failed"
    sed 's/^/    drop: /' "$DROP_LOG" 2>/dev/null || true
fi
rm -f "$DROP_LOG"

DEAD_TOKEN=""
LOGIN_FAILED=0
for _ in $(seq 1 10); do
    DEAD_TOKEN=$(login)
    if [ -z "$DEAD_TOKEN" ] || [ "$DEAD_TOKEN" = "null" ]; then
        LOGIN_FAILED=1
        break
    fi
    sleep 2
done
if [ "$LOGIN_FAILED" -eq 1 ]; then
    pass "Login fails after database destruction (as expected)"
else
    fail "Login still succeeds after dropping the schema"
fi

echo "  Recovering via scripts/recover.sh (no Studio, no API)..."
CID=$(docker compose ps -q directus)
if echo y | CONTAINER="$CID" bash "$PKG_DIR/scripts/recover.sh" "$BACKUP_ID" >/tmp/dr.log 2>&1; then
    grep -q ARMED /tmp/dr.log \
        && pass "recover.sh armed the restore and restarted the container" \
        || fail "recover.sh did not arm the restore (see /tmp/dr.log)"
else
    fail "recover.sh exited non-zero (see /tmp/dr.log)"
    sed 's/^/    dr: /' /tmp/dr.log 2>/dev/null || true
fi

echo "  Re-discovering host port + waiting for recovery..."
NEW_PORT=""
for _ in $(seq 1 30); do
    HP=$(docker compose port directus 8055 2>/dev/null) || true
    NEW_PORT="${HP##*:}"
    [ -n "$NEW_PORT" ] && break
    sleep 2
done
if [ -n "$NEW_PORT" ]; then
    HOST_PORT="$NEW_PORT"
    BASE_URL="http://localhost:$HOST_PORT"
    API="$BASE_URL/backup-api"
fi

if wait_ping 60; then
    pass "Directus healthy after disaster recovery"
else
    fail "Directus not responding after disaster recovery"
fi

REC_TOKEN=""
for _ in $(seq 1 10); do
    REC_TOKEN=$(login)
    [ -n "$REC_TOKEN" ] && [ "$REC_TOKEN" != "null" ] && break
    sleep 3
done
if [ -n "$REC_TOKEN" ] && [ "$REC_TOKEN" != "null" ]; then
    pass "Login works again after CLI restore (database recovered)"
else
    fail "Login still fails after CLI restore (recovery did not work)"
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Directus logs (tail):"
    docker compose logs directus --tail 30 2>&1
    exit 1
fi
