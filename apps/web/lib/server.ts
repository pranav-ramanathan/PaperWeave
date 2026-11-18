// The web app's handles on the database, sign-in and email. Created on first use, so building
// the app does not need a database.
import {
  AppError,
  blobStore,
  type BlobStore,
  connect,
  createAuth,
  type Auth,
} from '@paperweave/server';
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
let store: BlobStore | undefined;
export const blobs = () => (store ??= blobStore());
export const auth = () => services().auth;
export const baseUrl = () => need('BETTER_AUTH_URL').replace(/\/$/, '');

/** A form posted to a route handler must come from this site's own pages. */
export const sameOrigin = (request: Request) =>
  request.headers.get('origin') === new URL(baseUrl()).origin;

/**
 * The request with its body read, or null if the body is larger than `max` bytes. Reading stops
 * as soon as it is too large, whatever the request said its length was.
 */
export async function bounded(request: Request, max: number): Promise<Request | null> {
  const reader = request.body?.getReader();
  if (!reader) return request;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: Buffer.concat(chunks),
  });
}

/** A small JSON body, or null if it is not JSON or is larger than anything this site sends. */
export const readJson = async (request: Request, max = 200_000) =>
  (await bounded(request, max))?.json().catch(() => null) ?? null;

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
