// A short-lived ticket that tells the sync server who is connecting. The sync server may live on
// another host, where the session cookie would not reach it. Asked for with a file, the answer
// also says when that file's paper was last restored, so that a client coming back online can
// tell that the text it was editing has been replaced.
import { AppError, lastRestore, syncTicket } from '@paperweave/server';
import { currentUser, db } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const ticket = syncTicket(process.env.BETTER_AUTH_SECRET!, user.id);
  const file = new URL(request.url).searchParams.get('file');
  const restored = file
    ? await lastRestore(db(), user.id, file).catch((err) => {
        // Not their file: the sync server will refuse the connection itself.
        if (err instanceof AppError) return null;
        throw err;
      })
    : null;
  return Response.json({ ticket, restored }, { headers: { 'cache-control': 'no-store' } });
}
