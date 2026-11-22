// Sign-in. Better Auth owns the user, session, account and verification tables.
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { magicLink } from 'better-auth/plugins';
import { createHash } from 'node:crypto';
import type pg from 'pg';

type Env = Record<string, string | undefined>;
/** `url` is the page that asks the person to confirm; `token` is only ever read by that page's action. */
export type SendLink = (to: { email: string; url: string; token: string }) => Promise<void>;

/** Only ever send people to a path on this site. */
export const safePath = (next: unknown, fallback = '/projects') =>
  typeof next === 'string' && /^\/(?!\/)/.test(next) && !next.includes('\\') ? next : fallback;

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
    advanced: { database: { generateId: 'uuid' } },
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
          if (!(await maySendSignInLink(pool, email)))
            throw new APIError('TOO_MANY_REQUESTS', {
              message: 'Too many sign-in links have been sent to this address. Try again later.',
            });
          try {
            await sendLink({
              email,
              url: confirmUrl(env.BETTER_AUTH_URL ?? '', token, url),
              token,
            });
          } catch (err) {
            // Not sent, so not counted: someone trying again while the mail is down should
            // not find themselves shut out for an hour once it is back.
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

/** How many sign-in links are sent to one address in an hour. */
export const SIGN_IN_LINKS_PER_HOUR = 10;

/**
 * Whether one more sign-in link may be sent to an address now, and if so, on record that it
 * was. The sign-in library limits how often one client may ask; this limits how often one
 * address is written to, whoever asks, so that the service cannot be used to fill someone's
 * inbox. Only a hash of the address is kept, and only for a day.
 */
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

export async function maySendSignInLink(
  pool: pg.Pool,
  email: string,
  perHour = SIGN_IN_LINKS_PER_HOUR,
): Promise<boolean> {
  const hash = addressHash(email);
  await pool.query("delete from sign_in_links where sent_at < now() - interval '1 day'");
  const { rowCount } = await pool.query(
    `insert into sign_in_links (email_hash)
     select $1 where (
       select count(*) from sign_in_links
       where email_hash = $1 and sent_at > now() - interval '1 hour'
     ) < $2`,
    [hash, perHour],
  );
  return rowCount === 1;
}
