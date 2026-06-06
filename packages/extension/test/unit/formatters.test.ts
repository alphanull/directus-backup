import { describe, it, expect, vi } from 'vitest';
import {
	formatSize,
	formatMB,
	formatDate,
	formatDuration,
	formatRelativeTime,
} from '../../src/module/composables/useFormatters.js';

describe('formatSize', () => {
	it('formats bytes', () => {
		expect(formatSize(500)).toBe('500 B');
	});

	it('formats KB', () => {
		expect(formatSize(2048)).toBe('2.0 KB');
	});

	it('formats MB', () => {
		expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
	});

	it('formats GB', () => {
		expect(formatSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
	});
});

describe('formatMB', () => {
	it('formats MB under 1024', () => {
		expect(formatMB(512)).toBe('512 MB');
	});

	it('formats GB', () => {
		expect(formatMB(2048)).toBe('2.0 GB');
	});

	it('formats TB', () => {
		expect(formatMB(2 * 1024 * 1024)).toBe('2.0 TB');
	});
});

describe('formatDate', () => {
	it('formats an ISO date string', () => {
		const result = formatDate('2026-01-15T10:30:00Z');
		expect(result).toBeTruthy();
		expect(typeof result).toBe('string');
	});

	it('returns empty string for falsy input', () => {
		expect(formatDate('')).toBe('');
	});

	it('returns something for invalid date (no throw)', () => {
		const result = formatDate('not-a-date');
		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(0);
	});
});

describe('formatDuration', () => {
	it('formats seconds', () => {
		expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:00:45Z')).toBe('45s');
	});

	it('formats minutes and seconds', () => {
		expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:02:30Z')).toBe('2m 30s');
	});

	it('returns dash for negative duration', () => {
		expect(formatDuration('2026-01-01T00:01:00Z', '2026-01-01T00:00:00Z')).toBe('—');
	});
});

describe('formatRelativeTime', () => {
	it('formats seconds as <1m', () => {
		const now = new Date();
		expect(formatRelativeTime(now.toISOString())).toBe('<1m');
	});

	it('formats minutes', () => {
		const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
		expect(formatRelativeTime(fiveMinAgo)).toBe('5m');
	});

	it('formats hours', () => {
		const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
		expect(formatRelativeTime(threeHoursAgo)).toBe('3h');
	});

	it('formats days', () => {
		const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
		expect(formatRelativeTime(twoDaysAgo)).toBe('2d');
	});
});
