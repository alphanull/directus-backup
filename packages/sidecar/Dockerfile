FROM node:22-alpine

# postgresql16-client: pg_dump/pg_restore for the default PostgreSQL adapter.
# The compose healthcheck probes /health with `wget`, which is provided by the
# BusyBox applet bundled in the Alpine base image (no extra package required).
RUN apk add --no-cache postgresql16-client

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js .
COPY lib/ ./lib/
COPY run.sh /app/run.sh
COPY adapters/ /app/adapters/
RUN chmod +x /app/run.sh /app/adapters/*.sh

EXPOSE 4700

CMD ["node", "server.js"]
