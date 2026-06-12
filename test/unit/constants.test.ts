/**
 * Contract constants: backup-ID and label validation regexes (trust boundary).
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect } from 'vitest';
import { BACKUP_ID_RE, LABEL_RE } from '../../src/shared/constants.js';

describe('BACKUP_ID_RE', () => {
    const valid = [
        '2026-05-24__14-30-00__manual',
        '2026-01-01__00-00-00__my-backup',
        '2025-12-31__23-59-59__test_123',
        '2026-05-24__14-30-00__A'
    ];
    const invalid = [
        '',
        'not-a-backup-id',
        '2026-5-24__14-30-00__manual',
        '2026-05-24__14-30-00__',
        '2026-05-24__14-30-00__has space',
        '2026-05-24__14-30-00__has/slash',
        '../2026-05-24__14-30-00__traversal',
        '2026-05-24_14-30-00__single-sep'
    ];

    it.each(valid)('matches valid ID: %s', id => {
        expect(BACKUP_ID_RE.test(id)).toBe(true);
    });

    it.each(invalid)('rejects invalid ID: %s', id => {
        expect(BACKUP_ID_RE.test(id)).toBe(false);
    });
});

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
