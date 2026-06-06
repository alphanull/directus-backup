/**
 * Sets the same version across all package manifests (root, extension, sidecar)
 * and their lockfiles, using `npm version` so each file stays correctly
 * formatted. Does not touch git. Usage: `npm run set-version <x.y.z>`.
 * @module   @alphanull/directus-backup/scripts/set-version
 * @requires node:child_process
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { execFileSync } from 'node:child_process';

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error('Usage: npm run set-version <x.y.z>');
    process.exit(1);
}

const dirs = ['.', 'packages/extension', 'packages/sidecar'];

for (const cwd of dirs) {
    execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd, stdio: 'inherit' });
}

console.log(`\nAll packages set to ${version}. Review the diff, then commit.`);
