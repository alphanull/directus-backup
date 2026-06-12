/**
 * Runtime context singleton.
 *
 * The Directus endpoint hands the extension a context object (services, schema
 * accessor, database, logger). Module-level helpers such as {@link notify} need
 * access to it without threading it through every call, so the handler stores it
 * once via {@link setRuntime} at startup — mirroring the sidecar's `ctx`
 * singleton pattern, but populated from the endpoint context instead of Docker.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

/** The subset of the Directus endpoint context the extension relies on. */
export interface Runtime {
    /** Resolves the current Directus schema snapshot. */
    getSchema: () => Promise<any>
    /** Directus service constructors (ItemsService, NotificationsService, …). */
    services: Record<string, any>
    /** Knex database instance. */
    database: any
    /** Directus logger. */
    logger: any
}

let runtime: Runtime | null = null;

/**
 * Stores the runtime context. Called once by the endpoint handler at startup.
 * @param r  The runtime context assembled from the endpoint context.
 */
export function setRuntime(r: Runtime): void {
    runtime = r;
}

/**
 * Returns the stored runtime context.
 * @returns The runtime context.
 * @throws If called before {@link setRuntime} — a programmer error, never expected at request time.
 */
export function getRuntime(): Runtime {
    if (!runtime) throw new Error('Runtime not initialised — setRuntime() must run at endpoint startup');
    return runtime;
}
