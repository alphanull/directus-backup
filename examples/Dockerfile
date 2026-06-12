# Directus image extended for the standalone backup extension.
#
# Two additions on top of the stock image:
#   1. The PostgreSQL client (pg_dump / pg_restore / psql) used by backup.sh and
#      restore.sh — the stock image does not ship it (~5 MB).
#   2. An entrypoint override so a pending restore runs on a clean boot, BEFORE
#      Directus starts and while the database has zero application connections.
#      The stub is embedded below via a heredoc, so this Dockerfile is the only
#      file you need. Heredocs require BuildKit (the default builder since
#      Docker 23 and in Docker Compose v2); for older build environments use
#      the separate entrypoint.sh file instead — see docs/installation.md.
#
# The base tag is pinned for reproducibility. The CMD below mirrors the stock
# Directus 11.x start command; if you bump the base image, copy the current CMD
# from it (overriding ENTRYPOINT resets the inherited CMD).
FROM directus/directus:11.17.4

USER root

# pg_dump / pg_restore / psql for the PostgreSQL adapter.
RUN corepack enable && apk add --no-cache postgresql16-client

# Boot-time restore stub (same content as entrypoint.sh): runs a pending
# restore before Directus starts. Generic — it only locates and runs the
# extension's restore.sh; without the extension it is a no-op pass-through.
# The quoted 'EOF' keeps ${...} literal so the variables are expanded at
# container runtime, not at build time.
COPY --chmod=755 <<'EOF' /entrypoint.sh
#!/bin/sh
BACKUP_DIR="${BACKUP_DIR:-/directus/backups}"
EXTENSIONS_DIR="${EXTENSIONS_DIR:-${EXTENSIONS_PATH:-/directus/extensions}}"

if [ -f "$BACKUP_DIR/.pending_restore" ] || [ -f "$BACKUP_DIR/.restore_processing" ]; then
  for f in "$EXTENSIONS_DIR"/.registry/*/scripts/restore.sh "$EXTENSIONS_DIR"/*/scripts/restore.sh; do
    if [ -f "$f" ]; then
      BACKUP_DIR="$BACKUP_DIR" sh "$f" || true
      break
    fi
  done
fi

exec docker-entrypoint.sh "$@"
EOF

# Create the backup directory owned by `node` BEFORE the named volume is mounted.
# A fresh named volume inherits the ownership of the image directory it covers,
# so this makes /directus/backups writable by the unprivileged Directus user
# (uid 1000) — exactly how /directus/uploads already works. Without this the
# volume is root-owned and the extension (running as `node`) cannot write.
RUN mkdir -p /directus/backups && chown node:node /directus/backups

USER node

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/bin/sh", "-c", ": && node cli.js bootstrap && pm2-runtime start ecosystem.config.cjs ;"]
