// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cookiesToSet } from './auth.ts';
import { testDb } from './testing.ts';

let t: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
afterEach(() => vi.useRealTimers());

// Every statement the pool runs, whether by `pool.query` or on a connection taken from it (which
// is how the sign-in library's own queries go).
const statements: string[] = [];
const count = (sql: unknown) => {
  statements.push(typeof sql === 'string' ? sql : ((sql as { text?: string }).text ?? ''));
};
let watched = false;
/**
 * Count every statement the pool's connections run, whoever asks: `pool.query`, and the sign-in
 * library's own queries, which go through a connection it takes from the pool.
 */
function watch(pool: pg.Pool) {
  if (watched) return;
  watched = true;
  const wrap = (client: pg.PoolClient) => {
    const run = client.query.bind(client) as (...a: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...a: unknown[]) => (count(a[0]), run(...a));
  };
  pool.on('connect', wrap);
  // Connections already made.
  for (const c of (pool as unknown as { _clients: pg.PoolClient[] })._clients) wrap(c);
}
const sessionReads = () => statements.filter((s) => /"?(session|user)"?/i.test(s)).length;
const jar = (cookies: { name: string; value: string }[]) =>
  new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') });
const parse = (cookie: string) =>
  cookie
    .split('; ')
    .map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1) }));
const get = (headers: Headers, fresh = false) =>
  t.auth.api.getSession({
    headers,
    returnHeaders: true,
    ...(fresh && { query: { disableCookieCache: true } }),
  });

test('a second request with the same session cookie, within the minute, does not ask the database', async () => {
  const me = await t.signIn('cache@example.com');
  watch(t.pool);
  statements.length = 0;
  const headers = new Headers({ cookie: me.cookie });
  expect((await get(headers)).response?.user.email).toBe('cache@example.com');
  expect((await get(headers)).response?.user.email).toBe('cache@example.com');
  expect(sessionReads()).toBe(0);
  // Asked not to use it, it does ask.
  statements.length = 0;
  expect((await get(headers, true)).response?.user.email).toBe('cache@example.com');
  expect(sessionReads()).toBeGreaterThan(0);
});

test('after the minute the database is asked, and the cookie it makes again is handed on', async () => {
  const me = await t.signIn('renew@example.com');
  watch(t.pool);
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
  statements.length = 0;
  // What a page does: the answer is right, but nothing it says can be kept.
  const first = await get(new Headers({ cookie: me.cookie }));
  expect(first.response?.user.email).toBe('renew@example.com');
  expect(sessionReads()).toBeGreaterThan(0);
  const renewed = cookiesToSet(first.headers).filter((c) => c.name.endsWith('session_data'));
  expect(renewed.length).toBeGreaterThan(0);
  // What a route handler does: pass them on, and the next request is the cache's again.
  const kept = parse(me.cookie).filter((c) => !c.name.endsWith('session_data'));
  statements.length = 0;
  const next = await get(jar([...kept, ...renewed]));
  expect(next.response?.user.email).toBe('renew@example.com');
  expect(sessionReads()).toBe(0);
});

test('signing out ends the cache with the session: the same cookies are no longer anyone', async () => {
  const me = await t.signIn('out@example.com');
  const headers = new Headers({ cookie: me.cookie });
  expect((await get(headers)).response).not.toBeNull();
  const out = await t.auth.handler(
    new Request(`${process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        cookie: me.cookie,
        origin: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
        'content-type': 'application/json',
      },
      body: '{}',
    }),
  );
  expect(out.ok).toBe(true);
  // The browser is told to drop both the session and its cache.
  const dropped = out.headers.getSetCookie().filter((c) => /max-age=0/i.test(c));
  expect(dropped.some((c) => /session_token=/.test(c))).toBe(true);
  expect(dropped.some((c) => /session_data=/.test(c))).toBe(true);
  // The browser's own jar, after it has obeyed.
  const kept = parse(me.cookie).filter((c) => !/session_(token|data)$/.test(c.name));
  expect((await get(jar(kept))).response).toBeNull();
  // Even if the cache cookie were left behind: without the session cookie it is not read.
  const cacheOnly = parse(me.cookie).filter((c) => !/session_token$/.test(c.name));
  expect(cacheOnly.some((c) => /session_data/.test(c.name))).toBe(true);
  expect((await get(jar(cacheOnly))).response).toBeNull();
});

test('a session ended elsewhere goes on working from the cache for the minute, and no longer for the sync ticket', async () => {
  const me = await t.signIn('elsewhere@example.com');
  await t.pool.query(`delete from session where "userId" = $1`, [me.id]);
  const headers = new Headers({ cookie: me.cookie });
  // The trade that was accepted: pages and actions.
  expect((await get(headers)).response?.user.email).toBe('elsewhere@example.com');
  // What must not wait: asked of the database.
  expect((await get(headers, true)).response).toBeNull();
  // After the minute, nothing is left of it.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
  expect((await get(headers)).response).toBeNull();
});
