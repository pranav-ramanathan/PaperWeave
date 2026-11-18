// The proposed edits of a paper (?file=<id> for one file's), and proposing one.
import { AppError, listProposals, propose } from '@paperweave/server';
import { blobs, currentUser, db, sameOrigin } from '../../../../lib/server';

type Params = { params: Promise<{ id: string }> };
const failed = (err: unknown) => {
  if (err instanceof AppError) return Response.json({ error: err.message }, { status: err.status });
  throw err;
};

export async function GET(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    const file = new URL(request.url).searchParams.get('file') ?? undefined;
    const found = await listProposals(db(), blobs(), user.id, (await params).id, file);
    return Response.json(found, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return failed(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== 'object')
      throw new AppError('invalid_input', 'That is not a proposal.');
    const bytes = (v: unknown) =>
      typeof v === 'string' && v.length <= 200 ? new Uint8Array(Buffer.from(v, 'base64')) : null;
    const id = await propose(db(), blobs(), user.id, (await params).id, String(input.file ?? ''), {
      from: bytes(input.from),
      to: bytes(input.to),
      replacement: input.replacement,
      reason: input.reason,
    });
    return Response.json({ id });
  } catch (err) {
    return failed(err);
  }
}
