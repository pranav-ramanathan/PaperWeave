// Helpers for tests that need the services in infra/compose.yaml.
import { connect } from './db.ts';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createAuth } from './auth.ts';
import { migrate } from './migrate.ts';

/** Defaults match infra/compose.yaml; the environment overrides them. */
export const TEST_ENV = {
  DATABASE_URL: 'postgres://paperweave:paperweave@localhost:5432/paperweave',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_BUCKET: 'paperweave-test',
  S3_ACCESS_KEY: 'dev',
  S3_SECRET_KEY: 'dev',
  BETTER_AUTH_SECRET: 'local-tests-only-3kq9Zr7mVx2Lp8Tn5Wc1Yd4Hb6Jf0Gs',
  BETTER_AUTH_URL: 'http://localhost:3000',
  GRAMMAR_URL: 'http://localhost:8010',
  ...process.env,
} as Record<string, string>;

/** A fresh, migrated database that is dropped again by `close`. */
export async function testDb() {
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: TEST_ENV.DATABASE_URL, max: 1 });
  await admin.query(`create database ${name}`);
  const url = new URL(TEST_ENV.DATABASE_URL);
  url.pathname = '/' + name;
  // Made the way the services make theirs, so that it too survives a connection being lost.
  const pool = connect(url.href);
  await migrate(pool);
  const links: { email: string; url: string; token: string }[] = [];
  const auth = createAuth(pool, async (link) => void links.push(link), TEST_ENV);
  return {
    pool,
    auth,
    /** Every sign-in link "sent" so far. */
    links,
    /** Sign in as the confirm page does, with the emailed link's token. Returns the user's ID and session cookie. */
    async signIn(email: string, name?: string) {
      const base = TEST_ENV.BETTER_AUTH_URL + '/api/auth';
      const asked = await auth.handler(
        new Request(base + '/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, ...(name !== undefined && { name }) }),
        }),
      );
      if (!asked.ok) throw new Error(`sign-in request failed: ${asked.status}`);
      // What the confirm page's action does when its button is pressed.
      const verified = await auth.api.magicLinkVerify({
        query: { token: links.at(-1)!.token },
        headers: new Headers(),
        returnHeaders: true,
      });
      const cookie = verified.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      if (!session) throw new Error('sign-in did not produce a session');
      return { id: session.user.id, email: session.user.email, cookie };
    },
    url: url.href,
    async close() {
      await pool.end();
      // The pool's sockets may still be closing: wait for them rather than cutting them off.
      for (let i = 0; ; i++) {
        const dropped = await admin.query(`drop database ${name}`).then(
          () => true,
          (err) => (i < 100 ? false : Promise.reject(err)),
        );
        if (dropped) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await admin.end();
    },
  };
}
