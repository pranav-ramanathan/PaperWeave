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

test('the client is path-style by default and virtual-hosted when S3_PATH_STYLE says false', async () => {
  const base = {
    S3_ENDPOINT: 'https://store.example.com/',
    S3_PUBLIC_ENDPOINT: 'https://public.example.com',
    S3_BUCKET: 'b',
    S3_ACCESS_KEY: 'k',
    S3_SECRET_KEY: 's',
  };
  const digest = sha256(new Uint8Array([1]));
  const link = (env: Record<string, string>) =>
    blobStore({ ...base, ...env }).link(digest, { type: 'application/pdf', disposition: 'inline' });
  const upload = (env: Record<string, string>) =>
    blobStore({ ...base, ...env }).uploadUrl(
      '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12),
      5,
    );
  const key = `sha256/${digest.slice(0, 2)}/${digest}`;
  const fetched: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return new Response(null, { status: 200, headers: { 'content-length': '1' } });
  });
  try {
    // Unset and "true" are the same, and are what every existing setup has.
    expect(new URL(await link({})).href.startsWith(`https://public.example.com/b/${key}?`)).toBe(
      true,
    );
    expect(new URL(await link({ S3_PATH_STYLE: 'true' })).pathname).toBe(`/b/${key}`);
    expect(new URL((await upload({})).url).pathname).toMatch(/^\/b\/tmp\//);
    expect(new URL(await link({ S3_PATH_STYLE: 'false' })).origin).toBe(
      'https://b.public.example.com',
    );
    expect(new URL(await link({ S3_PATH_STYLE: 'false' })).pathname).toBe(`/${key}`);
    expect(new URL((await upload({ S3_PATH_STYLE: 'false' })).url).pathname).toMatch(/^\/tmp\//);
    // What the process itself asks for goes to the same style.
    await blobStore({ ...base }).size(digest);
    await blobStore({ ...base, S3_PATH_STYLE: 'false' }).size(digest);
    expect(fetched).toContain(`https://store.example.com/b/${key}`);
    expect(fetched).toContain(`https://b.store.example.com/${key}`);
    expect(() => blobStore({ ...base, S3_PATH_STYLE: 'maybe' })).toThrow('S3_PATH_STYLE');
  } finally {
    spy.mockRestore();
  }
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
