// Sign-in. Better Auth owns the user, session, account and verification tables.
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { magicLink } from 'better-auth/plugins';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type pg from 'pg';

type Env = Record<string, string | undefined>;
/** `url` is the page that asks the person to confirm; `token` is only ever read by that page's action. */
export type SendLink = (to: { email: string; url: string; token: string }) => Promise<void>;

/**
 * Only ever send people to a path on this site. Browsers drop tab, newline and return from an
 * address, so `/<TAB>/host` leaves the site as `//host`: no control character or space is
 * allowed, nor a backslash. What is left must still be on this site once parsed.
 */
export const safePath = (next: unknown, fallback = '/projects') => {
  if (typeof next !== 'string' || !/^\/(?!\/)/.test(next)) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u0020\u007f]/.test(next)) return fallback;
  try {
    const url = new URL(next, 'http://x.invalid');
    if (url.origin !== 'http://x.invalid') return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
};

/**
 * What the email carries: a page that changes nothing until its button is pressed. The library's
 * own link signs in on a plain GET, which mail scanners make before the person sees the email.
 * `libraryUrl` is read only for where the person was going.
 */
export const confirmUrl = (base: string, token: string, libraryUrl: string) => {
  let next: string | null = null;
  try {
    next = new URL(libraryUrl).searchParams.get('callbackURL');
  } catch {
    // no address, no destination
  }
  const url = new URL('/sign-in/confirm', base);
  url.searchParams.set('token', token);
  url.searchParams.set('next', safePath(next));
  return url.href;
};

export const SESSION_CACHE_SECONDS = 60;

/**
 * The cookies a call to the sign-in library asked to set, as a browser-ready list. A page cannot
 * set cookies, so the cache that `getSession` renews once it has run out is only renewed where
 * the caller can pass these on.
 */
export const cookiesToSet = (headers: Headers) => {
  // One cookie may be expired and then set again in one answer: the last is what a browser keeps.
  const last = new Map<string, { name: string; value: string; options: object }>();
  for (const line of headers.getSetCookie())
    for (const [name, c] of parseSetCookieHeader(line))
      last.set(name, { name, value: c.value, options: toCookieOptions(c) });
  return [...last.values()];
};

export const authOptions = (pool: pg.Pool, sendLink: SendLink, env: Env = process.env) =>
  ({
    database: pool,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // UUIDs, so our own tables can reference users with a real foreign key type.
    advanced: {
      database: { generateId: 'uuid' },
      // A client's address is only ever read from the one header an operator names as set by
      // their own proxy (TRUSTED_IP_HEADER). Any client can send `x-forwarded-for`, so by default
      // no address is read at all.
      ipAddress: trustedHeader(env)
        ? { ipAddressHeaders: [trustedHeader(env)!] }
        : { disableIpTracking: true },
    },
    // Limits by client address need a trustworthy address, so they are on only with
    // TRUSTED_IP_HEADER. Without it the limits are the ones below on the address written to and
    // on all sign-in emails together. Kept in the database, so that every instance of the web
    // app counts the same clients (the table is made with the others, used or not).
    rateLimit: {
      enabled: Boolean(trustedHeader(env)),
      storage: 'database',
      customRules: {
        // A request without a usable single address in the header is not counted at all: the
        // library would put every such request in one bucket shared by everyone.
        '/**': (req: Request, rule: { window: number; max: number }) =>
          isIP(req.headers.get(trustedHeader(env) ?? '')?.trim() ?? '') ? rule : false,
      },
    },
    session: {
      // Pages and actions are read with the session as the browser last kept it, for up to
      // this many seconds, without asking the database who is signed in. It costs this: a
      // session ended on another device goes on working in this browser for pages and actions
      // for up to this long. What it does not touch: who may do what on a paper (`authorize`
      // reads the database each time), the sync server (it checks the database itself), and
      // signing out in this browser (the cookies are cleared, and without the session cookie
      // the cache is not read). A fixed value, not a setting: docs/settings.md.
      cookieCache: { enabled: true, maxAge: SESSION_CACHE_SECONDS },
    },
    // The library's own link signs in on a plain GET. It is not reachable through the handler;
    // the confirm page's action calls `magicLinkVerify` directly.
    disabledPaths: ['/magic-link/verify'],
    plugins: [
      magicLink({
        // The link is the credential: store only its hash.
        storeToken: 'hashed',
        expiresIn: 15 * 60,
        sendMagicLink: async ({ email, url, token }) => {
          // Said to the person asking as "too many requests", not as a fault of the server.
          const may = await maySendSignInLink(pool, email, perHour(env));
          if (may === 'address')
            throw new APIError('TOO_MANY_REQUESTS', { message: ADDRESS_REFUSED });
          if (may === 'busy') throw new APIError('TOO_MANY_REQUESTS', { message: BUSY_REFUSED });
          try {
            await sendLink({
              email,
              url: confirmUrl(env.BETTER_AUTH_URL ?? '', token, url),
              token,
            });
          } catch (err) {
            // Not sent, so not counted: someone trying again while the mail is down should
            // not find themselves shut out once it is back.
            await forgetSignInLink(pool, email);
            throw err;
          }
        },
      }),
    ],
  }) satisfies BetterAuthOptions;

export const createAuth = (pool: pg.Pool, sendLink: SendLink, env: Env = process.env) =>
  betterAuth(authOptions(pool, sendLink, env));
export type Auth = ReturnType<typeof createAuth>;

/** Links to one address: a burst of this many, then one more each `SIGN_IN_SPACING_MINUTES`. */
export const SIGN_IN_BURST = 3;
export const SIGN_IN_SPACING_MINUTES = 6;
/** Sign-in emails sent to anyone in an hour, when SIGN_IN_EMAILS_PER_HOUR does not say. */
export const SIGN_IN_EMAILS_PER_HOUR = 500;

export const ADDRESS_REFUSED =
  'A sign-in link was sent to this address a few minutes ago. Use the newest email, or try again in a few minutes.';
export const BUSY_REFUSED =
  'Sign-in emails are being sent at the most this service allows for the hour. Try again in a little while.';

/** The header an operator has said their own proxy sets to the client's address, if any. */
const trustedHeader = (env: Env) => env.TRUSTED_IP_HEADER?.trim().toLowerCase() || undefined;
const perHour = (env: Env) => {
  const n = Number(env.SIGN_IN_EMAILS_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : SIGN_IN_EMAILS_PER_HOUR;
};

const addressHash = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** Take the newest sign-in link off the record for an address: it was not sent after all. */
export async function forgetSignInLink(pool: pg.Pool, email: string): Promise<void> {
  await pool.query(
    `delete from sign_in_links where ctid = (
       select ctid from sign_in_links where email_hash = $1 order by sent_at desc limit 1
     )`,
    [addressHash(email)],
  );
}

/**
 * Whether one more sign-in link may be sent to an address now, and if so, on record that it
 * was. Two limits, neither of which depends on who asks (so that nobody can use the service to
 * fill an inbox, and nobody can shut someone else out):
 * - one address: a burst of `SIGN_IN_BURST`, then one more every `SIGN_IN_SPACING_MINUTES`. A
 *   link lives 15 minutes, so whoever is refused has been sent one in the last few minutes,
 *   which is still good. (Counting links per hour instead let ten requests lock an address
 *   out for most of the hour.)
 * - all addresses: `perHour` emails in an hour, for the cost of the mail service.
 * Only a hash of the address is kept, and only for a day. 'address' and 'busy' say which limit
 * refused.
 */
export async function maySendSignInLink(
  pool: pg.Pool,
  email: string,
  perHour = SIGN_IN_EMAILS_PER_HOUR,
): Promise<'ok' | 'address' | 'busy'> {
  const hash = addressHash(email);
  const client = await pool.connect();
  try {
    await client.query('begin');
    // One decision at a time: two requests must not both see room for one more.
    await client.query('select pg_advisory_xact_lock(7265002)');
    await client.query("delete from sign_in_links where sent_at < now() - interval '1 day'");
    const { rows } = await client.query<{ at: number; now: number }>(
      `select extract(epoch from sent_at)::float8 as at, extract(epoch from now())::float8 as now
       from sign_in_links where email_hash = $1 order by sent_at`,
      [hash],
    );
    // A bucket that holds the burst and fills by one each spacing, emptied by one for each send.
    const spacing = SIGN_IN_SPACING_MINUTES * 60;
    let tokens = SIGN_IN_BURST;
    let last = rows[0]?.at ?? 0;
    for (const { at } of rows) {
      tokens = Math.min(SIGN_IN_BURST, tokens + (at - last) / spacing) - 1;
      last = at;
    }
    const now = rows[0]?.now ?? 0;
    tokens = Math.min(SIGN_IN_BURST, tokens + (now - last) / spacing);
    let answer: 'ok' | 'address' | 'busy' = 'ok';
    if (rows.length && tokens < 1) answer = 'address';
    else {
      const { rows: n } = await client.query<{ n: string }>(
        "select count(*) as n from sign_in_links where sent_at > now() - interval '1 hour'",
      );
      if (Number(n[0].n) >= perHour) answer = 'busy';
    }
    if (answer === 'ok')
      await client.query('insert into sign_in_links (email_hash) values ($1)', [hash]);
    await client.query('commit');
    return answer;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The address a sign-in token was issued for, partly hidden, or null if there is no such token
 * or it has expired. Only reads: showing the confirm page must not use the token up. Anyone
 * with the token has the email it came in, so they know the address; the page is reachable
 * without signing in, so it shows the first letter and the domain, not the whole address.
 */
export async function signInLinkAddress(auth: Auth, token: string): Promise<string | null> {
  const stored = createHash('sha256').update(token).digest('base64url');
  const context = await auth.$context;
  const row = await context.internalAdapter.findVerificationValue(`magic-link:${stored}`);
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  try {
    const email = String(JSON.parse(row.value).email ?? '');
    const at = email.lastIndexOf('@');
    return at > 0 ? `${email[0]}…${email.slice(at)}` : null;
  } catch {
    return null;
  }
}
