# Development

## Repository Structure

This is a monorepo with two packages:

```
packages/
├── sidecar/     # Node.js backup sidecar + shell scripts (Docker container)
└── extension/   # Directus UI module + API endpoint (npm package)
```

## Local Development with a Host Project

You develop this repository against a separate **host project** that runs the actual Directus Compose stack. The file names and paths below (`dev-local.yml`, `base.yml`, `BACKUP_VERSION`, and the `ops/...` layout) are conventions of that host project — they do **not** exist in this repository. Adapt them to your own host project's structure.

Both components need local overrides. A single `dev-local.yml` Compose overlay handles both:

```yaml
# dev-local.yml — Compose overlay in your host project (gitignored)
services:
  backup:
    build: ../../packages/directus-backup/packages/sidecar

  directus:
    volumes:
      - ../../packages/directus-backup/packages/extension:/directus/extensions/directus-extension-backup
```

Paths are relative to the project root (`--project-directory`).

The host project should provide a `dev-local.yml.example` as template. The dev script auto-detects `dev-local.yml` and adds it to the Compose stack.

After changing extension source, rebuild and restart:

```sh
cd packages/extension && npm run build
# Directus picks up changes on next request (EXTENSIONS_AUTO_RELOAD=true)
# or: docker restart <directus-container>
```

## Deployment Scenarios

| Scenario | Sidecar | Extension |
|---|---|---|
| **Local dev** | `build:` override via `dev-local.yml` | Volume mount via `dev-local.yml` |
| **Prod (pre-publish)** | `docker build` + `docker push :test` | `rsync` extension dir to server |
| **Prod (release)** | `docker push :0.9.0` + `:latest` | `npm publish` + `rsync` to server |

### Prod Deployment Before npm Publish

**Sidecar:** Build image locally and push with a test tag:

```sh
docker build -t ghcr.io/alphanull/directus-backup:test ./packages/sidecar
docker push ghcr.io/alphanull/directus-backup:test
# On server: set BACKUP_VERSION=test in env
```

**Extension:** Copy the built extension directory to the server:

```sh
rsync -a --exclude=node_modules --exclude=.DS_Store \
  packages/extension/ admin@server:/srv/projects/<project>/extensions/directus-extension-backup/
```

The `dist/` files are committed, so no build step is needed on the server.

### Prod Deployment After npm Publish

**Sidecar:** Same as above, but with release tags:

```sh
docker build -t ghcr.io/alphanull/directus-backup:0.9.0 -t ghcr.io/alphanull/directus-backup:latest ./packages/sidecar
docker push ghcr.io/alphanull/directus-backup:0.9.0
docker push ghcr.io/alphanull/directus-backup:latest
```

**Extension:** Deploy to the server the same way as before publish (the package is on npm for the Marketplace, but the server install here uses `rsync`):

```sh
rsync -a --exclude=node_modules --exclude=.DS_Store \
  packages/extension/ admin@server:/srv/projects/<project>/extensions/directus-extension-backup/
```

### Local Image Test

Build and test the Docker image locally without pushing:

```sh
# 1. Build and tag locally
docker build -t ghcr.io/alphanull/directus-backup:0.9.0 ./packages/sidecar

# 2. Remove dev-local.yml override (so Compose uses the image instead of building)
#    base.yml uses: image: ghcr.io/alphanull/directus-backup:${BACKUP_VERSION:-latest}
#    Set BACKUP_VERSION=0.9.0

# 3. Start stack — Docker finds the local image, does not pull
docker compose up -d

# 4. Test backup + restore, check logs
docker logs <backup-container>
```

## Building the Sidecar

```sh
cd packages/sidecar
docker build -t directus-backup .
```

The image is based on `node:22-alpine` with `postgresql16-client` added for the default PostgreSQL adapter.

## Building the Extension

```sh
cd packages/extension
npm install
npm run build
```

This produces `dist/app.js` and `dist/api.js` which are committed (Directus convention for published extensions).

## Testing

```sh
# Extension type checking
cd packages/extension && npm run typecheck

# Extension tests
cd packages/extension && npm test

# Sidecar type checking (checkJs)
cd packages/sidecar && npm run typecheck

# Coverage (report only; HTML written to <package>/test/coverage/)
cd packages/extension && npm run test:coverage
cd packages/sidecar && npm run test:coverage
```

Coverage uses the `v8` provider and is report-only (no enforced thresholds). It also runs non-blocking in CI. Note: the extension report covers the testable `.ts` logic; `.vue` components are not instrumented in this setup.

## Versioning

All packages (root, `packages/extension`, `packages/sidecar`) share one synchronized version number.

Set the version everywhere at once:

```sh
npm run set-version 0.10.0
```

This updates the `version` field in all three `package.json` files and their lockfiles. It does **not** touch git — review the diff and commit yourself.

`npm run check-versions` fails if the three versions drift apart. It runs in CI (the `lint` job) and gates the release workflow.

## Releasing

Releases run via the **Release** workflow (`.github/workflows/release.yml`), triggered manually with `workflow_dispatch`. Before triggering it, run `npm run set-version <x.y.z>`, commit, and push to `main`.

The workflow runs these jobs in order:

1. `version-check` — fails unless the three package versions are identical
2. `lint` — ESLint + Stylelint across the repo (gates both publish jobs)
3. `test` + `integration` — typecheck, unit tests, and integration tests
4. `publish-extension` — builds, verifies the committed `dist/` is up to date, then `npm publish`
5. `publish-sidecar` — builds and pushes the multi-arch Docker image tagged `:<version>` and `:latest`
6. `release` — creates the git tag `v<version>` and a GitHub release with auto-generated notes
