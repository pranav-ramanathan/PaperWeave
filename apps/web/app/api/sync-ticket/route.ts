// A short-lived ticket that tells the sync server who is connecting. The sync server may live on
// another host, where the session cookie would not reach it.
import { syncTicket } from '@paperweave/server';
import { currentUser } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const ticket = syncTicket(process.env.BETTER_AUTH_SECRET!, user.id);
  return Response.json({ ticket }, { headers: { 'cache-control': 'no-store' } });
}
