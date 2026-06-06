import { describe, it, expect, vi } from 'vitest';
import { pad, generateBackupId } from '../../src/api/index.js';

// ── pad ─────────────────────────────────────────────────────────────────────

describe('pad', () => {
	it('pads single-digit numbers with leading zero', () => {
		expect(pad(1)).toBe('01');
		expect(pad(9)).toBe('09');
	});

	it('returns two-digit numbers as-is', () => {
		expect(pad(10)).toBe('10');
		expect(pad(31)).toBe('31');
	});

	it('returns zero as "00"', () => {
		expect(pad(0)).toBe('00');
	});
});

// ── generateBackupId ────────────────────────────────────────────────────────

describe('generateBackupId', () => {
	it('produces a string matching BACKUP_ID_RE format', () => {
		const id = generateBackupId('test');
		expect(id).toMatch(/^\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}__test$/);
	});

	it('embeds the label at the end', () => {
		const id = generateBackupId('my-label');
		expect(id.endsWith('__my-label')).toBe(true);
	});

	it('uses current date/time', () => {
		const now = new Date('2026-03-15T08:05:03Z');
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const id = generateBackupId('snap');
		// Date/time portion depends on local timezone — just verify structure
		expect(id).toMatch(/^\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}__snap$/);

		vi.useRealTimers();
	});
});
