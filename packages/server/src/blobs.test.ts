import { createServer as http } from 'node:http';
import { createServer as tcp, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { blobStore, sha256 } from './blobs.ts';

const servers: Server[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of servers.splice(0)) s.close();
});
const store = (port: number) =>
  blobStore({
    S3_ENDPOINT: `http://127.0.0.1:${port}`,
    S3_BUCKET: 'b',
    S3_ACCESS_KEY: 'k',
    S3_SECRET_KEY: 's',
  });
const listen = (s: Server, port = 0) =>
  new Promise<number>((r) => {
    servers.push(s);
    s.listen(port, '127.0.0.1', () => r((s.address() as AddressInfo).port));
  });

test('a store that was not there once is asked again, not remembered as failed', async () => {
  // A port nobody listens on.
  const probe = tcp();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  const s = store(port);
  const bytes = new Uint8Array([1, 2, 3]);
  await expect(s.put(bytes)).rejects.toThrow();
  await listen(http((_, res) => void res.end()) as unknown as Server, port);
  expect(await s.put(bytes)).toBe(sha256(bytes));
});

test('a store that accepts and never answers is given up on after 10 seconds', async () => {
  const port = await listen(tcp(() => {}));
  const s = store(port);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const asked = expect(s.size(sha256(new Uint8Array([1])))).rejects.toMatchObject({
    code: 'unavailable',
  });
  await vi.advanceTimersByTimeAsync(10_001);
  await asked;
});
