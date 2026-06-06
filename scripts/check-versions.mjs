/**
 * Fails if the version fields of the three package manifests (root, extension,
 * sidecar) are not identical. Used as a release/CI gate so versions cannot
 * drift apart unnoticed. Usage: `npm run check-versions`.
 * @module   @alphanull/directus-backup/scripts/check-versions
 * @requires node:fs
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';

const files = ['package.json', 'packages/extension/package.json', 'packages/sidecar/package.json'];
const versions = files.map(file => ({ file, version: JSON.parse(readFileSync(file, 'utf8')).version }));
const distinct = [...new Set(versions.map(entry => entry.version))];

if (distinct.length !== 1) {
    console.error('Version mismatch across package.json files:');
    for (const { file, version } of versions) console.error(`  ${version}\t${file}`);
    console.error('\nRun `npm run set-version <x.y.z>` to sync them.');
    process.exit(1);
}

console.log(`All package versions match: ${distinct[0]}`);
