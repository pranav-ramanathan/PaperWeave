// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { authOptions, cookiesToSet, createAuth, signInLinkAddress } from './auth.ts';
import { TEST_ENV, testDb } from './testing.ts';

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

const sessionRows = async () =>
  Number((await t.pool.query('select count(*) from "session"')).rows[0].count);

test('a mail scanner that fetches the emailed address does not use the link up or get a session', async () => {
  const email = 'scanned@example.com';
  const base = `${TEST_ENV.BETTER_AUTH_URL}/api/auth`;
  const asked = await t.auth.handler(
    new Request(`${base}/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackURL: '/projects/abc#comments' }),
    }),
  );
  expect(asked.status).toBe(200);
  const link = t.links.at(-1)!;
  const sent = new URL(link.url);
  expect(sent.pathname).toBe('/sign-in/confirm');
  expect(sent.searchParams.get('next')).toBe('/projects/abc#comments');
  const before = await sessionRows();
  // The scanner: no cookies, a plain GET of the emailed address, and of the library's own link.
  const scanner = await t.auth.handler(new Request(link.url));
  const old = await t.auth.handler(
    new Request(`${base}/magic-link/verify?token=${link.token}&callbackURL=%2Fprojects`),
  );
  expect(scanner.headers.getSetCookie()).toEqual([]);
  expect(old.status).toBe(404);
  expect(old.headers.getSetCookie()).toEqual([]);
  expect(await sessionRows()).toBe(before);
  // The person's own press still works, once.
  const verified = await t.auth.api.magicLinkVerify({
    query: { token: link.token },
    headers: new Headers(),
    returnHeaders: true,
  });
  expect(verified.headers.getSetCookie().join()).toContain('session_token=');
  expect(await sessionRows()).toBe(before + 1);
  await expect(
    t.auth.api.magicLinkVerify({ query: { token: link.token }, headers: new Headers() }),
  ).rejects.toThrow();
});

test('a destination that is not a path on this site is not carried into the emailed address', async () => {
  for (const bad of [
    'https://evil.example/x',
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
  ]) {
    await t.auth.handler(
      new Request(`${TEST_ENV.BETTER_AUTH_URL}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'dest@example.com', callbackURL: bad }),
      }),
    );
    expect(new URL(t.links.at(-1)!.url).searchParams.get('next')).toBe('/projects');
  }
});

// What a person at a browser does, as far as the sign-in library can tell: a POST, from a client
// the server may or may not be able to tell apart from others.
const ask = (auth: typeof t.auth, email: string, headers: Record<string, string> = {}) =>
  auth.handler(
    new Request(`${TEST_ENV.BETTER_AUTH_URL}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email }),
    }),
  );
const sentTo = (links: typeof t.links, email: string) =>
  links.filter((l) => l.email === email).length;
const sink = () => {
  const links: typeof t.links = [];
  return { links, send: async (l: (typeof t.links)[number]) => void links.push(l) };
};
beforeEach(async () => void (await t.pool.query('delete from sign_in_links')));

test('ten requests by others do not shut the owner out: refused only while a link under six minutes old exists', async () => {
  const { links, send } = sink();
  const auth = createAuth(t.pool, send, TEST_ENV);
  const victim = 'victim@example.org';
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++)
    statuses.push((await ask(auth, victim, { 'x-forwarded-for': `203.0.113.${i + 1}` })).status);
  // A burst of three, then refused.
  expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429, 429, 429]);
  expect(sentTo(links, victim)).toBe(3);
  const mine = await ask(auth, victim);
  expect(mine.status).toBe(429);
  expect(((await mine.json()) as { message: string }).message).toBe(
    'A sign-in link was sent to this address a few minutes ago. Use the newest email, or try again in a few minutes.',
  );
  // The refusal is only because a link under six minutes old exists, and it is still good.
  const newest = await t.pool.query(
    `select now() - max(sent_at) < interval '6 minutes' as fresh from sign_in_links`,
  );
  expect(newest.rows[0].fresh).toBe(true);
  // Six minutes on, the owner is sent one; and the refusal is back at once after.
  await t.pool.query("update sign_in_links set sent_at = sent_at - interval '7 minutes'");
  expect((await ask(auth, victim)).status).toBe(200);
  expect(sentTo(links, victim)).toBe(4);
  expect((await ask(auth, victim)).status).toBe(429);
  // Long after, the whole burst is back.
  await t.pool.query("update sign_in_links set sent_at = sent_at - interval '30 minutes'");
  for (let i = 0; i < 3; i++) expect((await ask(auth, victim)).status).toBe(200);
});

test('with no trusted address header, five requests by one caller do not refuse another address', async () => {
  const { links, send } = sink();
  // The library limits by client only in production; run this file with NODE_ENV=production to
  // see the old behaviour fail (a shared bucket: five a minute, then everyone is refused).
  expect(authOptions(t.pool, send, TEST_ENV).rateLimit.enabled).toBe(false);
  const auth = createAuth(t.pool, send, TEST_ENV);
  for (let i = 0; i < 8; i++) expect((await ask(auth, `anon${i}@example.org`)).status).toBe(200);
  expect((await ask(auth, 'unrelated@example.org')).status).toBe(200);
  expect(links).toHaveLength(9);
});

test('spoofed single-value forwarded headers do not buy more emails to one address, nor get past the global cap', async () => {
  const { links, send } = sink();
  const auth = createAuth(t.pool, send, { ...TEST_ENV, SIGN_IN_EMAILS_PER_HOUR: '12' });
  let n = 0;
  for (let i = 0; i < 40; i++)
    await ask(auth, 'spoofed@example.org', { 'x-forwarded-for': `198.51.100.${++n}` });
  expect(sentTo(links, 'spoofed@example.org')).toBe(3);
  for (let i = 0; i < 40; i++)
    await ask(auth, `spoof${i}@example.org`, { 'x-forwarded-for': `198.51.100.${++n}` });
  // The cap counts everything sent in the hour, wherever it was asked from.
  expect(links.length).toBe(12);
});

test('the global cap refuses past N with its own message, and a failed send does not use it up', async () => {
  const { links, send } = sink();
  const auth = createAuth(t.pool, send, { ...TEST_ENV, SIGN_IN_EMAILS_PER_HOUR: '4' });
  for (let i = 0; i < 4; i++) expect((await ask(auth, `cap${i}@example.org`)).status).toBe(200);
  const over = await ask(auth, 'cap-over@example.org');
  expect(over.status).toBe(429);
  expect(((await over.json()) as { message: string }).message).toMatch(/at the most/);
  expect(links).toHaveLength(4);
  // An hour on, room again.
  await t.pool.query("update sign_in_links set sent_at = sent_at - interval '61 minutes'");
  expect((await ask(auth, 'cap-over@example.org')).status).toBe(200);
});

test('where an operator names the header their proxy sets, a client is limited by it, and a request without it is not', async () => {
  const { send } = sink();
  const auth = createAuth(t.pool, send, { ...TEST_ENV, TRUSTED_IP_HEADER: 'X-Real-IP' });
  const from = (ip: string, i: number) =>
    ask(auth, `ip-${ip}-${i}@example.org`, { 'x-real-ip': ip });
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await from('192.0.2.7', i)).status);
  expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
  // Another client is not affected; nor is a request that does not carry the header.
  expect((await from('192.0.2.8', 0)).status).toBe(200);
  for (let i = 0; i < 7; i++)
    expect(
      (await ask(auth, `bare${i}@example.org`, { 'x-forwarded-for': '192.0.2.7' })).status,
    ).toBe(200);
});

test('the confirm page can say whose link it is without using it up', async () => {
  const { links, send } = sink();
  const auth = createAuth(t.pool, send, TEST_ENV);
  expect((await ask(auth, 'Reader@Example.org')).status).toBe(200);
  const { token } = links.at(-1)!;
  expect(await signInLinkAddress(auth, token)).toBe('R…@Example.org');
  expect(await signInLinkAddress(auth, token)).toBe('R…@Example.org');
  expect(await signInLinkAddress(auth, 'not-a-token')).toBeNull();
  // Still there to be used, once.
  const before = await sessionRows();
  await auth.api.magicLinkVerify({ query: { token }, headers: new Headers() });
  expect(await sessionRows()).toBe(before + 1);
  expect(await signInLinkAddress(auth, token)).toBeNull();
});
