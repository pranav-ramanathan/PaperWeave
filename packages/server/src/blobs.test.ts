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

test('a body of unknown length that keeps coming is not cut off after 10 seconds', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  let more!: () => void;
  const later = new Promise<void>((r) => (more = r));
  let sent!: () => void;
  const first = new Promise<void>((r) => (sent = r));
  // Chunked: no content-length. The second half comes only once the test says so.
  const port = await listen(
    http(async (_, res) => {
      res.write(bytes.slice(0, 2), () => sent());
      await later;
      res.end(bytes.slice(2));
    }) as unknown as Server,
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const got = store(port).get(sha256(bytes));
  await first;
  // Let the first half reach the reader, in real time, before the clock moves.
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  await vi.advanceTimersByTimeAsync(15_000);
  more();
  expect(await got).toEqual(bytes);
});

test('no timer is left running once a read or a HEAD has finished', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const port = await listen(
    http((_, res) => {
      res.setHeader('content-length', bytes.length);
      res.end(bytes);
    }) as unknown as Server,
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const s = store(port);
  expect(await s.size(sha256(bytes))).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
  expect(await s.get(sha256(bytes))).toEqual(bytes);
  expect(vi.getTimerCount()).toBe(0);
});
