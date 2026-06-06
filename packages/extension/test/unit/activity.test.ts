import { describe, it, expect } from 'vitest';
import type { ActivityEntry } from '../../src/shared/activity.js';

describe('ActivityEntry type', () => {
	it('is structurally valid', () => {
		const entry: ActivityEntry = {
			timestamp: '2026-01-01T00:00:00Z',
			action: 'backup_success',
			backupId: 'test-id',
			source: 'manual',
		};
		expect(entry.action).toBe('backup_success');
		expect(entry.source).toBe('manual');
	});

	it('allows optional fields to be omitted', () => {
		const entry: ActivityEntry = {
			timestamp: '2026-01-01T00:00:00Z',
			action: 'config',
		};
		expect(entry.backupId).toBeUndefined();
		expect(entry.source).toBeUndefined();
		expect(entry.detail).toBeUndefined();
	});
});
