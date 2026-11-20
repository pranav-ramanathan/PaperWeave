// The threads of a paper (?file=<id> for one file's), and starting one.
import { AppError, getProject, listThreads, startThread } from '@paperweave/server';
import { blobs, currentUser, db, readJson, sameOrigin } from '../../../../lib/server';
import { failed, MENTION_LIMIT_NOTE, tellMentioned } from './mentions';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    const file = new URL(request.url).searchParams.get('file') ?? undefined;
    const threads = await listThreads(db(), blobs(), user.id, (await params).id, file);
    return Response.json(threads, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return failed(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const { id } = await params;
  try {
    const input = await readJson(request);
    if (!input || typeof input !== 'object')
      throw new AppError('invalid_input', 'That is not a comment.');
    const bytes = (v: unknown) =>
      typeof v === 'string' && v.length <= 200 ? new Uint8Array(Buffer.from(v, 'base64')) : null;
    const started = await startThread(db(), blobs(), user.id, id, String(input.file ?? ''), {
      from: bytes(input.from),
      to: bytes(input.to),
      body: input.body,
      mentions: input.mentions,
    });
    const paper = await getProject(db(), user.id, id);
    tellMentioned(started.mentioned, user.email, paper.name, id, String(input.file), started.id);
    return Response.json({ id: started.id, ...(started.limited && { note: MENTION_LIMIT_NOTE }) });
  } catch (err) {
    return failed(err);
  }
}
