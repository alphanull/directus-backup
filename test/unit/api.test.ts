/**
 * ID-generation helpers exported by the API endpoint module.
 * Ported from the extension suite.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

import { describe, it, expect, vi } from 'vitest';
import { pad, generateBackupId, validateScopeInput } from '../../src/api/http/validation.js';

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

describe('generateBackupId', () => {
    it('produces a string matching BACKUP_ID_RE format', () => {
        const id = generateBackupId('test');
        expect(id).toMatch(/^\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}__test$/u);
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
        expect(id).toMatch(/^\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}__snap$/u);

        vi.useRealTimers();
    });
});

describe('validateScopeInput boolean strictness', () => {
    it('rejects string "false" for database (Boolean("false") would be true)', () => {
        const r = validateScopeInput({ database: 'false' });
        expect(r.ok).toBe(false);
    });

    it('rejects string "true" for assets', () => {
        const r = validateScopeInput({ assets: 'true' });
        expect(r.ok).toBe(false);
    });

    it('rejects number 0 for extensions', () => {
        const r = validateScopeInput({ extensions: 0 });
        expect(r.ok).toBe(false);
    });

    it('rejects number 1 for database', () => {
        const r = validateScopeInput({ database: 1 });
        expect(r.ok).toBe(false);
    });

    it('accepts actual booleans and preserves false without coercion', () => {
        const r = validateScopeInput({ database: true, assets: false, extensions: true });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.database).toBe(true);
        expect(r.value.assets).toBe(false);
        expect(r.value.extensions).toBe(true);
    });
});
