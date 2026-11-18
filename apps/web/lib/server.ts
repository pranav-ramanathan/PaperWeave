// The web app's handles on the database, sign-in and email. Created on first use, so building
// the app does not need a database.
import { AppError, connect, createAuth, type Auth } from '@paperweave/server';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import nodemailer from 'nodemailer';

// Kept on globalThis so a dev-server reload does not open a second pool.
const g = globalThis as { __paperweave?: { pool: ReturnType<typeof connect>; auth: Auth } };

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export async function sendEmail(to: string, subject: string, text: string) {
  const from = process.env.EMAIL_FROM ?? 'PaperWeave <no-reply@localhost>';
  await nodemailer.createTransport(need('SMTP_URL')).sendMail({ from, to, subject, text });
}

function services() {
  if (g.__paperweave) return g.__paperweave;
  need('BETTER_AUTH_SECRET');
  need('BETTER_AUTH_URL');
  const pool = connect();
  const auth = createAuth(pool, ({ email, url }) =>
    sendEmail(
      email,
      'Sign in to PaperWeave',
      `Open this link to sign in to PaperWeave:\n\n${url}\n\nIt works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
    ),
  );
  return (g.__paperweave = { pool, auth });
}
export const db = () => services().pool;
export const auth = () => services().auth;
export const baseUrl = () => need('BETTER_AUTH_URL').replace(/\/$/, '');

/** Only ever send people to a path on this site. */
export const safePath = (next: unknown, fallback = '/projects') =>
  typeof next === 'string' && /^\/(?!\/)/.test(next) && !next.includes('\\') ? next : fallback;

export async function currentUser() {
  const session = await auth().api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

/** The signed-in user, or a trip to the sign-in page and back to `returnTo`. */
export async function requireUser(returnTo: string) {
  const user = await currentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`);
  return user;
}

/**
 * Run a form action. What the person got wrong comes back as a message on `back`; a project they
 * may not see is a 404; anything else is a bug and surfaces as one.
 */
export async function act(back: string, fn: () => Promise<string | void>): Promise<never> {
  let to: string;
  try {
    to = (await fn()) ?? back;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'not_found') notFound();
    to = `${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}`;
  }
  redirect(to);
}
