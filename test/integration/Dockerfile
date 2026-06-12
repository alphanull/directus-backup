# Directus image for the standalone backup extension's integration test.
#
# Adds the PostgreSQL client (pg_dump/pg_restore/psql, required by backup.sh and
# restore.sh) and overrides the entrypoint so a pending restore runs on boot
# before Directus starts (Mechanism A). Mirrors the production deployment
# documented in the extension README.
FROM directus/directus:11.17.4
USER root
RUN corepack enable && apk add --no-cache postgresql16-client
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Create the backup directory owned by `node` BEFORE the named volume is mounted.
# A fresh named volume inherits the ownership of the image directory it covers, so
# this makes /directus/backups writable by the unprivileged Directus user (uid
# 1000) — exactly how /directus/uploads already works. Without this the volume is
# root-owned and the extension (running as `node`) cannot write backups.
RUN mkdir -p /directus/backups && chown node:node /directus/backups
USER node
ENTRYPOINT ["/entrypoint.sh"]
# Overriding ENTRYPOINT resets the inherited CMD to empty, so re-declare the
# original Directus start command explicitly.
CMD ["/bin/sh", "-c", ": && node cli.js bootstrap && pm2-runtime start ecosystem.config.cjs ;"]
