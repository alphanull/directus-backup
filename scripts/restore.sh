#!/bin/sh
# Boot-time restore — runs on a fresh container boot BEFORE Directus starts,
# when the database has zero application connections.
#
# Invoked directly by the container ENTRYPOINT stub when a restore is pending.
# It never starts Directus itself; the stub does that afterwards via
# `exec docker-entrypoint.sh "$@"`. A restore in the standalone extension ONLY
# ever happens here (armed by the module via PID-1 restart, or by the
# disaster-recovery CLI `recover.sh`), so boot orchestration and the restore
# work live together in this one script.
#
# Handshake files live in $BACKUP_DIR (the backup volume, so they survive the
# restart that armed the restore):
#   .pending_restore     written by the extension/CLI; KEY=VALUE runner env
#   .restore_processing  this script's claim (loop guard against crash-restart)
#   .restore_done        restore succeeded
#   .restore_failed      restore failed
#
# Database credentials and CACHE_* come from the container environment (the same
# values Directus uses); only run-specific values are read from the flag file.
#
# The extension reconciles the manifest from the marker on the next Directus boot
# (single owner of backup.json), so this script only produces raw artefacts.
#
# @author  Frank Kudermann – alphanull
# @license AGPL-3.0-only

BACKUP_DIR="${BACKUP_DIR:-/directus/backups}"
FLAG="$BACKUP_DIR/.pending_restore"
PROCESSING="$BACKUP_DIR/.restore_processing"
DONE="$BACKUP_DIR/.restore_done"
FAILED="$BACKUP_DIR/.restore_failed"

SCRIPT_DIR=$(dirname "$0")

# Validates an inner archive for path traversal, symlinks, hard links, and
# device/special files — the same rules applied to the outer upload by import.ts.
# Returns 1 (with a message on stdout) if validation fails.
validate_inner_tar() {
  _arc="$1"
  _tmp=$(mktemp) || { echo "Cannot create temp file for inner archive validation"; return 1; }
  if ! tar tvzf "$_arc" > "$_tmp" 2>&1; then
    echo "Cannot read or decompress inner archive: $_arc"
    rm -f "$_tmp"
    return 1
  fi
  if awk 'NF < 6 { next }
    {
      perm = $1; first = substr(perm, 1, 1)
      file = ""; for (i = 6; i <= NF; i++) file = file (i > 6 ? " " : "") $i
      sub(/ ->.*$/, "", file)
      if (index("lhbcps", first) > 0) {
        print "Inner archive contains unsafe entry (" first "): " file
        exit 1
      }
      if (file ~ /^\// || file ~ /(^|\/)\.\.($|\/)/) {
        print "Inner archive contains unsafe path: " file
        exit 1
      }
    }' "$_tmp"; then
    rm -f "$_tmp"
    return 0
  else
    rm -f "$_tmp"
    return 1
  fi
}

# ── Restore body ──────────────────────────────────────────────
# Wrapped in a function so it can be run under a timeout watchdog via a re-exec
# (see __run_body below). Runs in a subshell with `set -e` so any hard failure
# (including the explicit `exit 1` on a requested-but-missing component) aborts
# the body and yields a non-zero RC, WITHOUT skipping the marker/cache handling.
run_restore_body() {
(
  set -e

  BACKUP_ID="${BACKUP_ID:?Missing BACKUP_ID}"
  BACKUP_PATH="${BACKUP_PATH:?Missing BACKUP_PATH}"
  DB_HOST="${DB_HOST:?Missing DB_HOST}"
  DB_USER="${DB_USER:?Missing DB_USER}"
  DB_PASSWORD="${DB_PASSWORD:?Missing DB_PASSWORD}"
  DB_DATABASE="${DB_DATABASE:?Missing DB_DATABASE}"
  UPLOADS_DIR="${UPLOADS_DIR:-/directus/uploads}"
  EXTENSIONS_DIR="${EXTENSIONS_DIR:-/directus/extensions}"
  RESTORE_INCLUDE_DB="${RESTORE_INCLUDE_DB:-1}"
  RESTORE_INCLUDE_ASSETS="${RESTORE_INCLUDE_ASSETS:-1}"
  RESTORE_INCLUDE_EXTENSIONS="${RESTORE_INCLUDE_EXTENSIONS:-0}"
  RESTORE_INCLUDE_TABLES="${RESTORE_INCLUDE_TABLES:-}"

  # ── Load database adapter ──
  DB_ADAPTER="${DB_ADAPTER:-postgres}"
  ADAPTER_FILE="$SCRIPT_DIR/adapters/${DB_ADAPTER}.sh"
  [ -f "$ADAPTER_FILE" ] || { echo "Unknown DB adapter: $DB_ADAPTER"; exit 1; }
  # shellcheck disable=SC1090
  . "$ADAPTER_FILE"
  db_init

  echo "Starting restore: $BACKUP_ID (adapter=$DB_ADAPTER)"

  # Verify checksums before touching anything
  if [ -f "$BACKUP_PATH/checksums.sha256" ]; then
    echo "Verifying backup checksums..."
    if ! (cd "$BACKUP_PATH" && sha256sum -c checksums.sha256); then
      MSG="Checksum verification failed — backup file(s) are corrupt"
      echo "$MSG"
      echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
      exit 1
    fi
    echo "Checksums OK"
  else
    echo "WARNING: No checksums.sha256 in backup — skipping checksum verify"
  fi

  # Per-component restore outcome (restored|skipped), consumed by the extension
  # to report what each component did. A requested component whose file is absent
  # is a hard error (see below), not a silent skip — the import path guarantees
  # that an archive's manifest scope matches its contents, so this can only happen
  # on a manipulated or truncated backup, in which case failing loudly is correct.
  RESTORE_RESULT="$BACKUP_PATH/restore-result.txt"
  : > "$RESTORE_RESULT"

  # ── Database restore ──
  if [ "$RESTORE_INCLUDE_DB" = "1" ]; then
    if [ -f "$BACKUP_PATH/database.dump" ]; then
      # Verify dump readability before any destructive db_restore operation
      # (mirrors the pg_restore --list check in restore.ts validateRestore so the
      # guard applies to both the API path and the disaster-recovery / recover.sh path).
      if [ "$DB_ADAPTER" = "postgres" ] && ! pg_restore --list "$BACKUP_PATH/database.dump" >/dev/null 2>&1; then
        MSG="Dump is not readable by pg_restore (custom-format check failed) — aborting before DROP SCHEMA"
        echo "$MSG"
        echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
        exit 1
      fi
      db_restore "$BACKUP_PATH" "$RESTORE_INCLUDE_TABLES"
      echo "db=restored" >> "$RESTORE_RESULT"
    else
      MSG="Database restore requested but no dump found in backup"
      echo "$MSG"
      echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
      exit 1
    fi
  else
    echo "Database restore skipped (RESTORE_INCLUDE_DB=0)"
    echo "db=skipped" >> "$RESTORE_RESULT"
  fi

  # ── Assets restore ──
  if [ "$RESTORE_INCLUDE_ASSETS" = "1" ]; then
    if [ -f "$BACKUP_PATH/uploads.tar.gz" ]; then
      echo "Validating uploads.tar.gz..."
      if ! validate_inner_tar "$BACKUP_PATH/uploads.tar.gz"; then
        MSG="uploads.tar.gz failed security validation — aborting restore"
        echo "$MSG"
        echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
        exit 1
      fi
      find "${UPLOADS_DIR:?}" -mindepth 1 -delete
      mkdir -p "$UPLOADS_DIR"
      tar xzf "$BACKUP_PATH/uploads.tar.gz" -C "$UPLOADS_DIR"
      echo "uploads restore complete"
      echo "assets=restored" >> "$RESTORE_RESULT"
    else
      MSG="Assets restore requested but uploads.tar.gz not found in backup"
      echo "$MSG"
      echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
      exit 1
    fi
  else
    echo "Assets restore skipped (RESTORE_INCLUDE_ASSETS=0)"
    echo "assets=skipped" >> "$RESTORE_RESULT"
  fi

  # ── Extensions restore ──
  if [ "$RESTORE_INCLUDE_EXTENSIONS" = "1" ]; then
    if [ -f "$BACKUP_PATH/extensions.tar.gz" ]; then
      echo "Validating extensions.tar.gz..."
      if ! validate_inner_tar "$BACKUP_PATH/extensions.tar.gz"; then
        MSG="extensions.tar.gz failed security validation — aborting restore"
        echo "$MSG"
        echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
        exit 1
      fi
      if [ -d "${EXTENSIONS_DIR}/.registry" ]; then
        rm -rf "${EXTENSIONS_DIR}/.registry"
      fi
      for ext_dir in "${EXTENSIONS_DIR}"/*/; do
        [ -d "$ext_dir" ] || continue
        rm -rf "$ext_dir"/* "$ext_dir"/.[!.]* "$ext_dir"/..?*
      done
      mkdir -p "$EXTENSIONS_DIR"
      tar xzf "$BACKUP_PATH/extensions.tar.gz" -C "$EXTENSIONS_DIR"
      echo "extensions restore complete"
      echo "extensions=restored" >> "$RESTORE_RESULT"
    else
      MSG="Extensions restore requested but extensions.tar.gz not found in backup"
      echo "$MSG"
      echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
      exit 1
    fi
  else
    echo "Extensions restore skipped (RESTORE_INCLUDE_EXTENSIONS=0)"
    echo "extensions=skipped" >> "$RESTORE_RESULT"
  fi

  # ── Post-restore count verification ──
  if [ "$RESTORE_INCLUDE_DB" = "1" ] && [ -f "$BACKUP_PATH/db-counts.txt" ]; then
    echo "Verifying restored table counts..."
    db_counts /tmp/actual-counts.txt
    MISMATCHES=0
    MISMATCH_FILE=/tmp/verify-mismatches.txt
    rm -f "$MISMATCH_FILE"

    INCLUDE_SET=""
    if [ -n "$RESTORE_INCLUDE_TABLES" ]; then
      INCLUDE_SET=",$RESTORE_INCLUDE_TABLES,"
    fi

    while IFS='=' read -r table expected; do
      case "$table" in ''|__*) continue ;; esac
      # Skip count check for tables not included in this restore.
      if [ -n "$INCLUDE_SET" ] && ! echo "$INCLUDE_SET" | grep -q ",$table,"; then
        continue
      fi
      actual=$(grep "^${table}=" /tmp/actual-counts.txt | cut -d= -f2)
      if [ "${actual:-0}" != "$expected" ]; then
        MISMATCHES=$((MISMATCHES + 1))
        echo "  MISMATCH: $table expected=$expected actual=${actual:-0}"
        printf 'mismatch.%s=%s->%s\n' "$table" "$expected" "${actual:-0}" >> "$MISMATCH_FILE"
      fi
    done < "$BACKUP_PATH/db-counts.txt"
    {
      printf 'mismatches=%d\n' "$MISMATCHES"
      [ -f "$MISMATCH_FILE" ] && cat "$MISMATCH_FILE"
    } > "$BACKUP_PATH/restore-verify.txt"
    [ "$MISMATCHES" -eq 0 ] \
      && echo "All table counts verified OK" \
      || echo "WARNING: $MISMATCHES table count mismatch(es) — see restore-verify.txt"
  fi
)
}

# ── Body-mode re-exec entry ───────────────────────────────────
# The watchdog runs the body via `setsid sh "$0" __run_body` so the body becomes
# its own process-group leader and the whole tree can be signalled at once. The
# parent has already claimed the flag and exported the run env, so this entry
# only runs the body and returns its exit code.
if [ "$1" = "__run_body" ]; then
  run_restore_body
  exit $?
fi

# A leftover .restore_processing means a previous boot crashed mid-restore.
# Do not re-run (the DB may be partially restored); mark failed and let the
# extension report it. This is the loop guard.
if [ -f "$PROCESSING" ]; then
  echo "[restore] Found stale .restore_processing — previous restore crashed; not re-running"
  mv "$PROCESSING" "$FAILED" 2>/dev/null || true
  exit 0
fi

[ -f "$FLAG" ] || exit 0

echo "[restore] Pending restore detected — claiming flag"
mv "$FLAG" "$PROCESSING" || { echo "[restore] Could not claim flag"; exit 0; }

# Export run-specific vars (BACKUP_ID, BACKUP_PATH, RESTORE_INCLUDE_*, …) for the
# restore body. set -a auto-exports everything sourced; DB_* and CACHE_* are
# already exported by the container environment.
set -a
# shellcheck disable=SC1090
. "$PROCESSING"
set +a

# ── Run the body under a wall-clock watchdog ──────────────────
# A restore runs on a clean boot with no external supervisor, so a hung
# pg_restore/psql/tar would block the boot indefinitely AND keep mutating the DB
# while Directus starts. Bound the body's wall-clock time and, on timeout,
# terminate the WHOLE process group (TERM, then KILL after a grace period) —
# mirroring the live runner's detached spawn + process.kill(-pid). This restores
# the restore-side timeout the sidecar had via spawnRunner.
# RUNNER_TIMEOUT_MIN comes from the container env (default 90); 0 disables it,
# matching the backup runner.
RUNNER_TIMEOUT_MIN="${RUNNER_TIMEOUT_MIN:-90}"
case "$RUNNER_TIMEOUT_MIN" in ''|*[!0-9]*) RUNNER_TIMEOUT_MIN=90 ;; esac
# Wall-clock budget in seconds. Normally derived from RUNNER_TIMEOUT_MIN;
# RUNNER_TIMEOUT_SEC overrides it so the runner tests can exercise the watchdog
# in seconds instead of whole minutes.
TIMEOUT_SECS="${RUNNER_TIMEOUT_SEC:-$((RUNNER_TIMEOUT_MIN * 60))}"
case "$TIMEOUT_SECS" in ''|*[!0-9]*) TIMEOUT_SECS=$((RUNNER_TIMEOUT_MIN * 60)) ;; esac
TIMED_OUT_FLAG="/tmp/.restore_timed_out.$$"
rm -f "$TIMED_OUT_FLAG"

if [ "$TIMEOUT_SECS" -gt 0 ] && command -v setsid >/dev/null 2>&1; then
  # setsid → the body is its own process-group leader, so $! is the group id and
  # `kill -- -$!` reaches every descendant (pg_restore/psql/tar). Verified that a
  # bare busybox `timeout` only signals the direct child and leaks grandchildren,
  # which would keep mutating the DB while Directus boots — hence the group kill,
  # mirroring the live runner's detached spawn + process.kill(-pid).
  setsid sh "$0" __run_body &
  BODY_PID=$!
  (
    sleep "$TIMEOUT_SECS"
    : > "$TIMED_OUT_FLAG"
    echo "[restore] Timeout after ${TIMEOUT_SECS}s — terminating restore process group"
    kill -TERM -"$BODY_PID" 2>/dev/null || true
    sleep 10
    kill -KILL -"$BODY_PID" 2>/dev/null || true
  ) &
  WATCH_PID=$!
  wait "$BODY_PID"; RC=$?
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
  if [ -f "$TIMED_OUT_FLAG" ]; then
    RC=124
    MSG="Restore aborted: exceeded the runner timeout (${RUNNER_TIMEOUT_MIN} min) and was terminated. The database may be left in a partially restored state — see runner.log and re-run the restore."
    echo "$MSG"
    echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
  fi
  rm -f "$TIMED_OUT_FLAG"
else
  if [ "$TIMEOUT_SECS" -gt 0 ]; then
    MSG="Restore aborted: RUNNER_TIMEOUT_MIN is enabled but 'setsid' is unavailable, so the restore timeout cannot be enforced. Install util-linux (setsid) or set RUNNER_TIMEOUT_MIN=0 to explicitly disable the watchdog."
    echo "$MSG"
    echo "$MSG" > "$BACKUP_PATH/restore-error.txt"
    RC=1
  else
    echo "[restore] Runner timeout disabled (RUNNER_TIMEOUT_MIN=0)"
    run_restore_body
    RC=$?
  fi
fi
echo "[restore] restore body exit=$RC"

# ── Redis cache flush (only the configured DB) ────────────────
# CACHE_HOST unset -> default "cache"; set empty -> skip (no Redis).
flush_cache() {
  _host="${CACHE_HOST-cache}"
  [ -z "$_host" ] && { echo "[restore] cache flush skipped (CACHE_HOST empty)"; return; }
  _port="${CACHE_PORT:-6379}"
  _db="${CACHE_DB:-0}"
  if ! command -v nc >/dev/null 2>&1; then
    echo "[restore] cache flush skipped (nc not available)"
    return
  fi
  {
    if [ "$_db" -gt 0 ] 2>/dev/null; then
      printf '*2\r\n$6\r\nSELECT\r\n$%s\r\n%s\r\n' "${#_db}" "$_db"
    fi
    printf '*1\r\n$7\r\nFLUSHDB\r\n'
  } | nc -w 3 "$_host" "$_port" >/dev/null 2>&1 \
    && echo "[restore] Redis cache flushed" \
    || echo "[restore] cache flush failed (non-fatal)"
}
flush_cache

# ── Leave the result marker for the extension to reconcile ────
if [ "$RC" -eq 0 ]; then
  mv "$PROCESSING" "$DONE" 2>/dev/null || true
  echo "[restore] Restore complete (marker: .restore_done)"
else
  mv "$PROCESSING" "$FAILED" 2>/dev/null || true
  echo "[restore] Restore failed (marker: .restore_failed)"
fi

exit 0
