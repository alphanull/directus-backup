/**
 * Display formatters for sizes, dates, and durations used across the module UI.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

/** Formats a byte count as a human-readable B/KB/MB/GB string. */
export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(1)} GB`;
}

/** Formats a megabyte count as a human-readable MB/GB/TB string. */
export function formatMB(mb: number): string {
    if (mb < 1024) return `${mb} MB`;
    const gb = mb / 1024;
    if (gb < 1024) return `${gb.toFixed(1)} GB`;
    return `${(gb / 1024).toFixed(1)} TB`;
}

/** Formats an ISO timestamp using the browser locale; returns the input on failure. */
export function formatDate(iso: string): string {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

/** Formats the elapsed time between two ISO timestamps as `Xm Ys`; `—` if negative. */
export function formatDuration(start: string, end: string): string {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
}

/** Formats an ISO timestamp as a compact relative age (`<1m`, `5m`, `3h`, `2d`). */
export function formatRelativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return '<1m';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
}
