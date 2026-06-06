import { describe, it, expect } from 'vitest';
import {
	buildCronExpr,
	parseEnabledFlag,
	BACKUP_ID_RE,
	VALID_SCHEDULES,
	VALID_RETENTIONS,
	DEFAULT_CONFIG,
	DEFAULT_SCOPE,
} from '../../lib/config.js';

// ── buildCronExpr ───────────────────────────────────────────────

describe('buildCronExpr', () => {
	it('returns null for "off"', () => {
		expect(buildCronExpr('off', 0, 0)).toBeNull();
	});

	it('returns null for unknown schedule', () => {
		expect(buildCronExpr('bogus', 0, 0)).toBeNull();
	});

	it('1h uses minute only', () => {
		expect(buildCronExpr('1h', 15, 0)).toBe('15 * * * *');
	});

	it('6h uses minute + every-6h', () => {
		expect(buildCronExpr('6h', 30, 0)).toBe('30 */6 * * *');
	});

	it('12h uses minute + every-12h', () => {
		expect(buildCronExpr('12h', 0, 0)).toBe('0 */12 * * *');
	});

	it('daily uses hour', () => {
		expect(buildCronExpr('daily', 0, 3)).toBe('0 3 * * *');
	});

	it('3d uses hour + every-3d', () => {
		expect(buildCronExpr('3d', 0, 12)).toBe('0 12 */3 * *');
	});

	it('weekly runs on Sunday', () => {
		expect(buildCronExpr('weekly', 0, 6)).toBe('0 6 * * 0');
	});

	it('clamps minute to 0–59', () => {
		expect(buildCronExpr('1h', -5, 0)).toBe('0 * * * *');
		expect(buildCronExpr('1h', 99, 0)).toBe('59 * * * *');
	});

	it('clamps hour to 0–23', () => {
		expect(buildCronExpr('daily', 0, -1)).toBe('0 0 * * *');
		expect(buildCronExpr('daily', 0, 30)).toBe('0 23 * * *');
	});
});

// ── parseEnabledFlag ────────────────────────────────────────────

describe('parseEnabledFlag', () => {
	const enabled = ['true', '1'];
	const disabled = [undefined, '', '0', 'false', 'yes', 'TRUE', 'True', 'on', ' true'];

	it.each(enabled)('enables for %s', (v) => {
		expect(parseEnabledFlag(v)).toBe(true);
	});

	it.each(disabled)('stays disabled (secure-by-default) for %s', (v) => {
		expect(parseEnabledFlag(v)).toBe(false);
	});
});

// ── BACKUP_ID_RE ────────────────────────────────────────────────

describe('BACKUP_ID_RE', () => {
	const valid = [
		'2026-06-03__17-38-53__manual',
		'2026-01-01__00-00-00__my-backup',
		'2025-12-31__23-59-59__test_123',
	];
	const invalid = [
		'',
		'not-a-backup-id',
		'2026-5-24__14-30-00__manual',
		'2026-05-24__14-30-00__',
		'2026-05-24__14-30-00__has space',
		'../2026-05-24__14-30-00__traversal',
	];

	it.each(valid)('matches valid ID: %s', (id) => {
		expect(BACKUP_ID_RE.test(id)).toBe(true);
	});

	it.each(invalid)('rejects invalid ID: %s', (id) => {
		expect(BACKUP_ID_RE.test(id)).toBe(false);
	});
});

// ── Constants ───────────────────────────────────────────────────

describe('schedule/retention sets', () => {
	it('VALID_SCHEDULES contains expected values', () => {
		expect(VALID_SCHEDULES).toContain('off');
		expect(VALID_SCHEDULES).toContain('daily');
		expect(VALID_SCHEDULES).toContain('weekly');
	});

	it('VALID_RETENTIONS contains expected values', () => {
		expect(VALID_RETENTIONS).toContain('all');
		expect(VALID_RETENTIONS).toContain('last-5');
		expect(VALID_RETENTIONS).toContain('days-30');
	});
});

describe('DEFAULT_CONFIG', () => {
	it('has schedule off by default', () => {
		expect(DEFAULT_CONFIG.schedule).toBe('off');
	});

	it('has retention all by default', () => {
		expect(DEFAULT_CONFIG.retention).toBe('all');
	});

	it('has minFreeMB 100 by default', () => {
		expect(DEFAULT_CONFIG.minFreeMB).toBe(100);
	});
});

describe('DEFAULT_SCOPE', () => {
	it('includes database and assets, excludes extensions', () => {
		expect(DEFAULT_SCOPE.database).toBe(true);
		expect(DEFAULT_SCOPE.assets).toBe(true);
		expect(DEFAULT_SCOPE.extensions).toBe(false);
	});
});
