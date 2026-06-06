import { describe, it, expect } from 'vitest';
import { isValidBackupId } from '../../src/shared/path.js';
import { BACKUP_ID_RE, LABEL_RE } from '../../src/shared/constants.js';

// ── BACKUP_ID_RE ────────────────────────────────────────────────────────────

describe('BACKUP_ID_RE', () => {
	const valid = [
		'2026-05-24__14-30-00__manual',
		'2026-01-01__00-00-00__my-backup',
		'2025-12-31__23-59-59__test_123',
		'2026-05-24__14-30-00__A',
	];
	const invalid = [
		'',
		'not-a-backup-id',
		'2026-5-24__14-30-00__manual',       // single-digit month
		'2026-05-24__14-30-00__',             // empty label
		'2026-05-24__14-30-00__has space',    // space in label
		'2026-05-24__14-30-00__has/slash',    // slash in label
		'../2026-05-24__14-30-00__traversal', // path traversal prefix
		'2026-05-24_14-30-00__single-sep',    // single underscore separator
	];

	it.each(valid)('matches valid ID: %s', (id) => {
		expect(BACKUP_ID_RE.test(id)).toBe(true);
	});

	it.each(invalid)('rejects invalid ID: %s', (id) => {
		expect(BACKUP_ID_RE.test(id)).toBe(false);
	});
});

// ── LABEL_RE ────────────────────────────────────────────────────────────────

describe('LABEL_RE', () => {
	it('matches alphanumeric + dash + underscore', () => {
		expect(LABEL_RE.test('my-backup_01')).toBe(true);
	});

	it('rejects spaces', () => {
		expect(LABEL_RE.test('has space')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(LABEL_RE.test('')).toBe(false);
	});
});

// ── isValidBackupId ─────────────────────────────────────────────────────────

describe('isValidBackupId', () => {
	it('returns true for a valid ID', () => {
		expect(isValidBackupId('2026-05-24__14-30-00__manual')).toBe(true);
	});

	it('returns false for garbage', () => {
		expect(isValidBackupId('garbage')).toBe(false);
	});

	it('returns false for empty string', () => {
		expect(isValidBackupId('')).toBe(false);
	});
});
