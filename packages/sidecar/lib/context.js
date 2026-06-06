/**
 * Shared runtime singletons populated once at startup.
 *
 * ES modules are module-level singletons in Node.js — every importer receives
 * the same `docker` instance and the same `ctx` object reference.
 * @author   Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import Docker from 'dockerode';

export const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/**
 * Runtime context populated by `discoverDirectus()` before the HTTP server starts.
 * @type {{ directusContainerId: string | undefined }}
 */
export const ctx = {
    directusContainerId: undefined
};
