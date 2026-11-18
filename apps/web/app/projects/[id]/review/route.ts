// Ask for a model review of a stretch of a file: {file, from, to}. What comes back is stored as
// proposed changes and questions; this answers with how many of each.
import { AppError, reviewPassage } from '@paperweave/server';
import { blobs, currentUser, db, sameOrigin } from '../../../../lib/server';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    const input = await request.json().catch(() => null);
    const bytes = (v: unknown) =>
      typeof v === 'string' && v.length <= 200 ? new Uint8Array(Buffer.from(v, 'base64')) : null;
    const done = await reviewPassage(
      db(),
      blobs(),
      user.id,
      (await params).id,
      String(input?.file ?? ''),
      { from: bytes(input?.from), to: bytes(input?.to) },
    );
    return Response.json(done);
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
