import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { flushCache } from '../../lib/runner.js';

/**
 * Minimal fake Redis: collects received bytes and replies `+OK\r\n` once per
 * RESP command (each command starts with a `*<n>\r\n` array header), which is
 * what flushCache counts before resolving.
 */
function startFakeRedis() {
	const received = [];
	const server = createServer(socket => {
		socket.on('data', chunk => {
			const text = chunk.toString();
			received.push(text);
			const commandCount = (text.match(/\*\d+\r\n/g) || []).length;
			socket.write('+OK\r\n'.repeat(commandCount || 1));
		});
	});
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => {
			resolve({ server, port: server.address().port, received });
		});
	});
}

let active = null;

afterEach(() => {
	if (active) {
		active.server.close();
		active = null;
	}
});

describe('flushCache', () => {
	it('sends FLUSHDB only when db = 0 and resolves', async () => {
		active = await startFakeRedis();
		await expect(flushCache({ host: '127.0.0.1', port: active.port, db: 0 })).resolves.toBeUndefined();

		const all = active.received.join('');
		expect(all).toContain('FLUSHDB');
		expect(all).not.toContain('SELECT');
	});

	it('sends SELECT <db> before FLUSHDB when db > 0', async () => {
		active = await startFakeRedis();
		await expect(flushCache({ host: '127.0.0.1', port: active.port, db: 2 })).resolves.toBeUndefined();

		const all = active.received.join('');
		expect(all).toContain('SELECT');
		expect(all).toContain('\r\n2\r\n'); // db index as a RESP bulk string
		expect(all).toContain('FLUSHDB');
		expect(all.indexOf('SELECT')).toBeLessThan(all.indexOf('FLUSHDB'));
	});

	it('is a no-op (resolves, no connection) when host is empty', async () => {
		active = await startFakeRedis();
		await expect(flushCache({ host: '', port: active.port })).resolves.toBeUndefined();
		expect(active.received).toHaveLength(0);
	});

	it('rejects when the target port is not listening', async () => {
		const { server, port } = await startFakeRedis();
		await new Promise(r => server.close(r)); // free the port, nothing listening now
		await expect(flushCache({ host: '127.0.0.1', port, db: 0 })).rejects.toBeTruthy();
	});
});
