// Sign-in. Better Auth owns the user, session, account and verification tables.
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
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
        sendMagicLink: ({ email, url }) => sendLink({ email, url }),
      }),
    ],
  }) satisfies BetterAuthOptions;

export const createAuth = (pool: pg.Pool, sendLink: SendLink, env: Env = process.env) =>
  betterAuth(authOptions(pool, sendLink, env));
export type Auth = ReturnType<typeof createAuth>;
