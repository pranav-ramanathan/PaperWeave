// The web app's handles on the database, sign-in and email. Created on first use, so building
// the app does not need a database.
import {
  AppError,
  blobStore,
  type BlobStore,
  connect,
  cookiesToSet,
  createAuth,
  findInvitation,
  getProject,
  listCharts,
  listFiles,
  withScope,
  type Auth,
} from '@paperweave/server';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { createHash } from 'node:crypto';
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
  // A mail server that does not answer must not hold up the person who asked for the email for
  // longer than this. (Given with the URL in one object: the options a URL does not set apply.)
  const transport = nodemailer.createTransport({
    url: need('SMTP_URL'),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  await transport.sendMail({ from, to, subject, text });
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
 * An answer that is private to the people on a paper and worth the browser's keeping: a PDF,
 * a picture. The browser may keep it, and must ask before each use. The server then sees who
 * is asking, and says "as you have it" without sending it again. Kept to be used unasked for
 * an hour, as these once were, it was handed to whoever sat at the browser next, signed in
 * or not.
 */
export function askedForEachTime(
  request: Request,
  body: Uint8Array | string,
  headers: Record<string, string>,
) {
  const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
  const all = { ...headers, etag, 'cache-control': 'private, no-cache' };
  return request.headers.get('if-none-match') === etag
    ? new Response(null, { status: 304, headers: all })
    : new Response(body as BodyInit, { headers: all });
}

/**
 * What a function may answer with in one piece is 4.5 MB (docs/deploy.md). A blob larger than
 * this is not read here: the browser is sent to the store for it, with an address good for five
 * minutes. Only for someone already found to be allowed it.
 */
export const DIRECT_MAX = 4_000_000;

/**
 * A stored file as the answer: from here if it is small (and kept by the browser as
 * `askedForEachTime` says), otherwise by a 303 to a signed address in the store.
 */
export async function sendBlob(request: Request, digest: string, headers: Record<string, string>) {
  const size = await blobs().size(digest);
  if (size === null) throw new AppError('not_found', 'No such file.');
  if (size > DIRECT_MAX) {
    const to = await blobs().link(digest, {
      type: headers['content-type'],
      disposition: headers['content-disposition'] ?? 'inline',
    });
    return new Response(null, {
      status: 303,
      headers: { Location: to, 'cache-control': 'no-store' },
    });
  }
  const bytes = await blobs().get(digest);
  if (!bytes) throw new AppError('not_found', 'No such file.');
  return askedForEachTime(request, bytes, headers);
}

/**
 * Send the browser on to a path of this site after a form is posted to a route handler. The
 * path goes out as it is. An address made from the request's own would be the one this
 * process listens on, which behind a proxy is not the one people use: the browser would be
 * sent to a machine it cannot reach, and the pages' own policy refuses a form that leads off
 * the site.
 */
export const seeOther = (path: string) =>
  new Response(null, { status: 303, headers: { Location: path } });

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

/**
 * Who is signed in, and the sign-in itself. The session is read from the cookie the browser
 * keeps of it for up to a minute (`session.cookieCache` in `createAuth`) without asking the
 * database. When that has run out the database is asked, and the cookie is made again: only
 * here is it passed on to the browser, and only where a response can set cookies (a route
 * handler, an action). A page cannot, so a page that is the only thing a browser asks for
 * goes back to the database every time the minute is up. The editor's build poll is what
 * keeps it going for someone who has an editor open.
 *
 * `fresh` reads the database whatever the cookie says, for what must not go on for even a
 * minute after the sign-in ended: the ticket for the sync server.
 */
export async function currentSession({ fresh = false } = {}) {
  const found = await auth().api.getSession({
    headers: await headers(),
    returnHeaders: true,
    ...(fresh && { query: { disableCookieCache: true } }),
  });
  const set = cookiesToSet(found.headers);
  if (set.length) {
    try {
      const store = await cookies();
      for (const { name, value, options } of set) store.set(name, value, options);
    } catch {
      // Not somewhere that can set cookies: the browser keeps what it has.
    }
  }
  return found.response;
}

// Within one page's render the page and its title ask who is signed in once between them
// (outside a render, `cache` does nothing).
export const currentUser = cache(async () => (await currentSession())?.user ?? null);

/**
 * What a page and its `<title>` both read about a paper, asked once between them in one render:
 * the same answer, from the same check that the person may see the paper, so a title is never
 * made from what the page would not show.
 */
export const paperOf = cache((userId: string, id: string) => getProject(db(), userId, id));
export const filesOf = cache((userId: string, id: string) => listFiles(db(), userId, id));
export const chartsOf = cache((userId: string, id: string) =>
  listCharts(db(), blobs(), userId, id),
);
export const invitationOf = cache((token: string, userId: string) =>
  findInvitation(db(), token, userId),
);

/**
 * For a title: what `load` reads for the signed-in person. A paper that is not theirs to see is
 * the page's not-found, as for the page itself, and nothing of it goes into a title. Null if no
 * one is signed in (the page sends them to sign in) or the read failed some other way (the
 * page shows that).
 */
export async function forTitle<T>(load: (userId: string) => Promise<T>): Promise<T | null> {
  const user = await currentUser();
  if (!user) return null;
  try {
    // In a scope, so what a title asks of one paper asks the paper's membership once.
    return await withScope(() => load(user.id));
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    return null;
  }
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
