// Run a structural edit on a file: replace one stretch of text if it still reads as expected.
// Answers 200 when it was applied (or had been already), 409 with the current text when not.
import { AppError, openFile, runCommand } from '@paperweave/server';
import { blobs, currentUser, db, sameOrigin } from '../../../../../../lib/server';

type Params = { params: Promise<{ id: string; fileId: string }> };
const refuse = (error: string, status: number) => Response.json({ error }, { status });

export async function POST(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return refuse('Sign in first.', 401);
  // Two texts of at most a million characters each, and a little besides.
  if (Number(request.headers.get('content-length') ?? 0) > 9_000_000)
    return refuse('That edit is too large.', 413);
  const body = await request.json().catch(() => null);
  const bytes = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'base64url') : undefined);
  const { id, fileId } = await params;
  try {
    // The address names the paper; the file must be one of its files.
    if ((await openFile(db(), user.id, fileId)).projectId !== id)
      throw new AppError('not_found', 'No such file.');
    const done = await runCommand(db(), blobs(), user.id, fileId, {
      ...body,
      from: bytes(body?.from),
      to: bytes(body?.to),
    });
    return Response.json(done, { status: done.result === 'conflict' ? 409 : 200 });
  } catch (err) {
    if (err instanceof AppError) return refuse(err.message, err.status);
    throw err;
  }
}
