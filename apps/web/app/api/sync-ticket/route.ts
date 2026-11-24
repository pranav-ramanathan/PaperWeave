// A short-lived ticket that tells the sync server who is connecting, and to which file. The sync
// server may live on another host, where the session cookie would not reach it. The answer also
// says when that file's paper was last restored, so that a client coming back online can tell
// that the text it was editing has been replaced.
import { AppError, lastRestoreNote, syncTicket } from '@paperweave/server';
import { currentSession, db } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Not from the cookie cache: a sign-in that has ended may not be given a ticket.
  const signedIn = await currentSession({ fresh: true });
  if (!signedIn) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const { user, session } = signedIn;
  const file = new URL(request.url).searchParams.get('file');
  if (!file) return Response.json({ error: 'Say which file.' }, { status: 400 });
  // The ticket names the sign-in it is given under: when that ends, so do its connections.
  const ticket = syncTicket(process.env.BETTER_AUTH_SECRET!, user.id, file, 60, session.id);
  const restore = await lastRestoreNote(db(), user.id, file).catch((err) => {
    // Not their file: the sync server will refuse the connection itself.
    if (err instanceof AppError) return undefined;
    throw err;
  });
  // The number alone says whether the paper was restored since this page last asked (0: never;
  // null: not their file). The rest is for telling the person who restored it, and to what.
  const restored = restore === undefined ? null : (restore?.number ?? 0);
  // Who it is for, so that a page left open by one person does not carry on as the next person
  // to sign in on the same browser.
  return Response.json(
    { ticket, restored, restore: restore ?? null, user: user.email },
    { headers: { 'cache-control': 'no-store' } },
  );
}
