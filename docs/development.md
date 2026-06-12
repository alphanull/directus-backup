# Development

The extension is a single, self-contained Directus **bundle** extension (`@directus/extensions-sdk`) with two entries — a Vue `module` and an `endpoint` — plus the shell scripts that perform the actual work.

## Package Structure

```text
directus-extension-backup/
├── src/
│   ├── api/          # Endpoint: index.ts (routes) + runner, storage, config,
│   │                 #   activity, notify, runtime
│   ├── module/       # Vue 3 UI module (BackupModule.vue, components, composables)
│   └── shared/       # Code shared by api + module (types, constants)
├── scripts/          # backup.sh, restore.sh, recover.sh, adapters/
├── test/             # unit/, api/, adapters/, runner/, integration/
├── dist/             # Built app.js + api.js (committed)
├── extension.config.js  # Rollup tweaks for the build (see below)
├── tsconfig.test.json
└── package.json
```

`src/api/` and `src/module/` share `src/shared/` so types and constants stay in sync between the server and the UI.

## Prerequisites

- Node.js ≥ 18
- For the integration test: Docker + Docker Compose

```sh
npm install
```

## Building

```sh
npm run build   # prebuild typecheck, then `directus-extension build --no-minify`
npm run dev     # watch build for local development
```

The build produces `dist/app.js` (the Vue module) and `dist/api.js` (the endpoint), which are **committed** — that is the layout Directus expects for an installed extension, so no build step is needed on the target server.

### `extension.config.js`

`node-cron` (used for scheduled backups) references `__dirname`, which does not exist in the ESM bundle the SDK produces. `extension.config.js` injects a small `__dirname` / `__filename` shim during the Rollup build so the bundled endpoint runs under Directus. Keep it in place; removing it reintroduces a `ReferenceError: __dirname is not defined` at runtime.

## Local Development Against a Directus Stack

Mount the package into a running Directus container as a local extension and rebuild as you change source:

```yaml
# Compose overlay in your host project
directus:
  volumes:
    - /path/to/directus-extension-backup:/directus/extensions/directus-extension-backup
```

The container also needs the restore entrypoint and a restart policy from [installation.md](installation.md). After changing source:

```sh
npm run build
# Directus picks up changes on next request (EXTENSIONS_AUTO_RELOAD=true)
# or: docker restart <directus-container>
```

> Note: the endpoint spawns `backup.sh` and uses direct DB access, so the container needs `pg_dump`/`pg_restore` and (for a Marketplace-style install) `MARKETPLACE_TRUST=all`.

## Testing

The test suite has four layers:

```sh
npm run typecheck        # tsc --noEmit (uses tsconfig.test.json)
npm test                 # vitest (unit + api) + shell adapter/runner tests
npm run test:watch       # vitest in watch mode
npm run test:coverage    # vitest coverage report (v8 provider)
npm run test:integration # full Docker stack: backup → restart-restore →
                         #   import round-trip → disaster recovery
```

Layout under `test/`:

<!-- markdownlint-disable MD060 -->
| Directory      | What it covers                                                                   |
| -------------- | -------------------------------------------------------------------------------- |
| `unit/`        | Pure logic (config, constants, formatters, scope, sanity) — no I/O               |
| `api/`         | Server behavior with I/O (storage, activity, recover, runner, handlers, import)  |
| `adapters/`    | Shell unit test for the PostgreSQL adapter restore logic                          |
| `runner/`      | Shell unit tests for `backup.sh` / `restore.sh` (restore accounting, path decoupling) |
| `integration/` | Self-contained Docker Compose stack exercising the full lifecycle end-to-end     |
<!-- markdownlint-enable MD060 -->

### Integration test notes

`test/integration/run.sh` builds the extension, brings up a Directus + PostgreSQL + Redis stack from `test/integration/Dockerfile` + `docker-compose.yml`, and drives backup, restart-based restore, download, import round-trip, and **disaster recovery** (it drops the database schema, recovers it via `scripts/recover.sh`, and asserts login works again) through the real Directus API.

- The stack publishes Directus on an **ephemeral host port**; the script discovers it via `docker compose port` (and re-discovers it after each container restart, since the mapped port changes).
- Run it as a tracked/foreground job. A detached `nohup` run can be reaped by the environment mid-`up`, leaving the Directus container in a `Created` state — which looks like a hang but is just an interrupted startup.

## Publishing

The package is published to npm as `@alphanull/directus-extension-backup` (public, per `publishConfig`). The published tarball includes `dist/`, `scripts/`, `docs/*.md`, `README.md`, `LICENSE`, and `package.json` (`files` in `package.json`, plus npm's default package metadata files). The committed `dist/` means installs need no build step. The same package is what the Directus Marketplace serves.
