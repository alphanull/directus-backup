#!/usr/bin/env bash
set -euo pipefail

# Integration test: spins up a full Directus + Backup stack,
# creates a backup, verifies it, restores it, and tears down.
#
# Usage: ./test/integration/run.sh
# Requires: docker compose, curl, jq

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/examples/docker-compose.yml"
ENV_FILE="$ROOT_DIR/examples/.env"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

cleanup() {
    echo "Tearing down..."
    cd "$ROOT_DIR/examples"
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f "$ENV_FILE"
}
trap cleanup EXIT

# ── Setup ────────────────────────────────────────────────────────

echo "Setting up integration test..."

cat > "$ENV_FILE" <<EOF
DIRECTUS_SECRET=$(openssl rand -hex 32)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=testpassword123
DB_USER=directus
DB_PASSWORD=$(openssl rand -hex 16)
DB_DATABASE=directus
BACKUP_SECRET=$(openssl rand -hex 32)
BACKUP_IMPORT_ENABLED=true
BACKUP_EXPORT_ENABLED=true
EOF

cd "$ROOT_DIR/examples"
echo "Building sidecar..."
docker compose build backup --quiet 2>&1

echo "Starting stack..."
docker compose up -d --wait --wait-timeout 120 2>&1

echo "Waiting for services to stabilize..."
sleep 5

# ── Get auth token ───────────────────────────────────────────────

echo ""
echo "Running tests..."

TOKEN=""
for i in $(seq 1 10); do
    TOKEN=$(curl -s -X POST http://localhost:8055/auth/login \
        -H "Content-Type: application/json" \
        -d '{"email":"admin@example.com","password":"testpassword123"}' \
        | jq -r '.data.access_token // empty' 2>/dev/null) || true
    if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then break; fi
    sleep 3
done

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    fail "Could not obtain auth token"
    echo "Directus logs:"
    docker compose logs directus --tail 20 2>&1
    exit 1
fi
pass "Auth token obtained"

# ── Extension loaded + access ─────────────────────────────────────

ACCESS=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8055/backup-api/check-access | jq -r '.access // empty' 2>/dev/null) || true
if [ "$ACCESS" = "true" ]; then
    pass "Extension loaded and accessible"
else
    fail "Extension not loaded or not accessible: $ACCESS"
fi

# ── Create backup ────────────────────────────────────────────────

CREATE_RESPONSE=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:8055/backup-api/create) || true
BACKUP_ID=$(echo "$CREATE_RESPONSE" | jq -r '.id // empty' 2>/dev/null) || true

if [ -n "$BACKUP_ID" ] && [ "$BACKUP_ID" != "null" ]; then
    pass "Backup created: $BACKUP_ID"
else
    fail "Backup creation failed: $CREATE_RESPONSE"
fi

# ── Wait for backup to complete ──────────────────────────────────

echo "  Waiting for backup to complete..."
for i in $(seq 1 30); do
    sleep 1
    STATUS=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8055/backup-api/list \
        | jq -r ".[0].status // empty" 2>/dev/null) || true
    if [ "$STATUS" = "success" ]; then break; fi
done

if [ "$STATUS" = "success" ]; then
    pass "Backup status: success"
else
    fail "Backup status: $STATUS (expected success)"
fi

# ── Verify backup has data ───────────────────────────────────────

TABLES=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8055/backup-api/list \
    | jq '.[0].verify.dumpTables // 0' 2>/dev/null) || true

if [ "$TABLES" -gt 0 ]; then
    pass "Backup contains $TABLES tables"
else
    fail "Backup has no tables"
fi

# ── Verify positive collection index ─────────────────────────────

COLLECTIONS=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8055/backup-api/list \
    | jq '.[0].scope.collections | length // 0' 2>/dev/null) || true

if [ -n "$COLLECTIONS" ] && [ "$COLLECTIONS" -gt 0 ]; then
    pass "Backup manifest has positive collection index ($COLLECTIONS collections)"
else
    fail "Backup manifest missing positive collection index"
fi

# ── Restore ──────────────────────────────────────────────────────

RESTORE=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    "http://localhost:8055/backup-api/$BACKUP_ID/restore" \
    | jq -r '.accepted // empty' 2>/dev/null) || true

if [ "$RESTORE" = "true" ]; then
    pass "Restore accepted"
else
    fail "Restore not accepted"
fi

echo "  Waiting for restore to complete..."
sleep 20

if docker compose logs backup 2>&1 | grep -q "Restore complete.*status=success"; then
    pass "Restore completed successfully"
else
    fail "Restore did not complete successfully"
fi

# ── Directus still healthy after restore? ────────────────────────

for i in $(seq 1 10); do
    PING=$(curl -s http://localhost:8055/server/ping 2>/dev/null) || true
    if [ "$PING" = "pong" ]; then break; fi
    sleep 2
done

if [ "$PING" = "pong" ]; then
    pass "Directus healthy after restore"
else
    fail "Directus not responding after restore"
fi

# ── Restore status in manifest ────────────────────────────────────

LIST_AFTER=$(curl -s -H "Authorization: Bearer $TOKEN" \
    http://localhost:8055/backup-api/list 2>/dev/null) || true

RESTORE_STATUS=$(echo "$LIST_AFTER" | jq -r '.[0].restoreStatus // empty' 2>/dev/null) || true
if [ "$RESTORE_STATUS" = "success" ]; then
    pass "Restore status in manifest: success"
else
    fail "Restore status in manifest: \"$RESTORE_STATUS\" (expected success)"
fi

RESTORE_DB=$(echo "$LIST_AFTER" | jq -r '.[0].restore.database // empty' 2>/dev/null) || true
if [ "$RESTORE_DB" = "restored" ]; then
    pass "Restore component database=restored"
else
    fail "Restore component database: \"$RESTORE_DB\" (expected restored)"
fi

# ── Download backup ───────────────────────────────────────────────

DOWNLOAD_TMP=$(mktemp)
DL_CODE=$(curl -s -o "$DOWNLOAD_TMP" -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "http://localhost:8055/backup-api/$BACKUP_ID/download") || true

if [ "$DL_CODE" = "200" ] && [ -s "$DOWNLOAD_TMP" ]; then
    pass "Backup downloaded ($(wc -c < "$DOWNLOAD_TMP" | tr -d ' ') bytes)"
else
    fail "Backup download failed: HTTP $DL_CODE"
fi

# ── Re-import same backup (duplicate → 409) ───────────────────────

REIMPORT1=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/gzip" \
    --data-binary "@$DOWNLOAD_TMP" \
    http://localhost:8055/backup-api/upload) || true

if [ "$REIMPORT1" = "409" ]; then
    pass "Re-import of existing backup rejected with 409"
else
    fail "Re-import (duplicate): expected 409, got $REIMPORT1"
fi

# ── Delete + re-import (download → delete → upload round-trip) ───

curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
    "http://localhost:8055/backup-api/$BACKUP_ID" >/dev/null 2>&1 || true

REIMPORT2=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/gzip" \
    --data-binary "@$DOWNLOAD_TMP" \
    http://localhost:8055/backup-api/upload) || true

if [ "$REIMPORT2" = "200" ]; then
    pass "Re-import after delete: 200"
else
    fail "Re-import after delete: expected 200, got $REIMPORT2"
fi

rm -f "$DOWNLOAD_TMP"

# ── Import hardening: inconsistent archive rejected ───────────────
# Archive whose manifest declares assets=true but is missing uploads.tar.gz.

INC_DIR=$(mktemp -d)
INC_ID="2000-01-01__00-00-00__test-import"
mkdir -p "$INC_DIR/$INC_ID"
printf '{"id":"%s","status":"success","scope":{"database":true,"assets":true,"extensions":false}}' \
    "$INC_ID" > "$INC_DIR/$INC_ID/backup.json"
echo "FAKE_DUMP" > "$INC_DIR/$INC_ID/database.dump"
# uploads.tar.gz intentionally absent (scope/content inconsistency).
tar czf "$INC_DIR/inconsistent.tar.gz" -C "$INC_DIR" "$INC_ID"

INC_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/gzip" \
    --data-binary "@$INC_DIR/inconsistent.tar.gz" \
    http://localhost:8055/backup-api/upload) || true

if [ "$INC_STATUS" = "400" ]; then
    pass "Import hardening: inconsistent archive rejected (400)"
else
    fail "Import hardening: expected 400, got $INC_STATUS"
fi

rm -rf "$INC_DIR"

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Logs:"
    docker compose logs backup --tail 20 2>&1
    exit 1
fi
