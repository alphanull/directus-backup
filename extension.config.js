/**
 * Build configuration for the Directus Extensions SDK.
 *
 * `node-cron` is bundled into the ESM API bundle. Its background-task module
 * references `__dirname` at load time, which does not exist in ES module scope —
 * so the unpatched bundle throws `ReferenceError: __dirname is not defined` and
 * the whole extension fails to register. We inject an `import.meta.url`-derived
 * `__dirname`/`__filename` shim into the Node API chunk only. We never use
 * node-cron's background (worker-thread) tasks, so the shim's value only needs
 * to exist, not point anywhere in particular. The browser app bundle never
 * references `__dirname`, so it is left untouched.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

const DIRNAME_SHIM = [
    "import { fileURLToPath as __backupFileURLToPath } from 'node:url';",
    "import { dirname as __backupDirname } from 'node:path';",
    'const __filename = __backupFileURLToPath(import.meta.url);',
    'const __dirname = __backupDirname(__filename);',
    ''
].join('\n');

export default {
    plugins: [
        {
            name: 'inject-dirname-shim',
            renderChunk(code, chunk) {
                if (chunk.fileName !== 'api.js') return null;
                if (!(/\b__dirname\b/u).test(code) && !(/\b__filename\b/u).test(code)) return null;
                return { code: DIRNAME_SHIM + code, map: null };
            }
        }
    ]
};
