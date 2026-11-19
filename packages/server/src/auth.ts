// Sign-in. Better Auth owns the user, session, account and verification tables.
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins';
import { createHash } from 'node:crypto';
import type pg from 'pg';

type Env = Record<string, string | undefined>;
export type SendLink = (to: { email: string; url: string }) => Promise<void>;

export const authOptions = (pool: pg.Pool, sendLink: SendLink, env: Env = process.env) =>
  ({
    database: pool,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // UUIDs, so our own tables can reference users with a real foreign key type.
    advanced: { database: { generateId: 'uuid' } },
    plugins: [
      magicLink({
        // The link is the credential: store only its hash.
        storeToken: 'hashed',
        expiresIn: 15 * 60,
        sendMagicLink: async ({ email, url }) => {
          // Said to the person asking as "too many requests", not as a fault of the server.
          if (!(await maySendSignInLink(pool, email)))
            throw new APIError('TOO_MANY_REQUESTS', {
              message: 'Too many sign-in links have been sent to this address. Try again later.',
            });
          try {
            await sendLink({ email, url });
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
