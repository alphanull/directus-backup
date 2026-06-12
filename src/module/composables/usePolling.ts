/**
 * Polling control for the backup module: a fast 5s loop while an operation is
 * running and a slow 30s idle loop to pick up background changes (for example,
 * scheduled backups). The two loops hand off to each other and never run together.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import type { ComputedRef } from 'vue';

/** Fetchers and state the polling loops depend on. */
export interface PollingDeps {
    fetchList: (options?: { silent?: boolean }) => Promise<void>
    fetchActivity: () => Promise<void>
    fetchStorage: () => Promise<void>
    hasRunning: ComputedRef<boolean>
}

/**
 * Creates the active/idle polling controllers.
 * @param deps  Fetchers and the `hasRunning` flag.
 * @returns     Start/stop functions for the active and idle loops.
 */
export function usePolling(deps: PollingDeps) {
    const { fetchList, fetchActivity, fetchStorage, hasRunning } = deps;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;

    /** Stops the active polling timer. */
    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    /** Stops the idle polling timer. */
    function stopIdlePolling() {
        if (idleTimer) {
            clearInterval(idleTimer);
            idleTimer = null;
        }
    }

    /** Starts 5s polling while an operation runs; stops itself once idle. Pauses idle polling while active. */
    function startPolling() {
        if (pollTimer) return;
        stopIdlePolling();
        pollTimer = setInterval(async() => {
            const wasRunning = hasRunning.value;
            await Promise.all([fetchList({ silent: true }), fetchActivity()]);
            if (!hasRunning.value) {
                stopPolling();
                if (wasRunning) await fetchStorage();
                startIdlePolling();
            }
        }, 5000);
    }

    /** Starts 30s idle polling to pick up background changes (for example, scheduled backups). */
    function startIdlePolling() {
        if (idleTimer) return;
        idleTimer = setInterval(async() => {
            if (hasRunning.value) {
                stopIdlePolling();
                startPolling();
                return;
            }
            await fetchList({ silent: true });
            if (hasRunning.value) {
                stopIdlePolling();
                startPolling();
            }
        }, 30000);
    }

    return { startPolling, stopPolling, startIdlePolling, stopIdlePolling };
}

/** Aggregate type of the polling controllers. */
export type BackupPolling = ReturnType<typeof usePolling>;
