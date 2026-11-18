// Answer a thread ({body, mentions}), resolve it or open it again ({status}), or attach it to
// its words again ({attach}).
import { AppError, getProject, reattachThread, reply, setThreadStatus } from '@paperweave/server';
import { blobs, currentUser, db, readJson, sameOrigin } from '../../../../../lib/server';
import { failed, tellMentioned } from '../mentions';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; threadId: string }> },
) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const { id, threadId } = await params;
  try {
    const input = await readJson(request);
    if (!input || typeof input !== 'object')
      throw new AppError('invalid_input', 'That is not a comment.');
    if ('attach' in input) await reattachThread(db(), blobs(), user.id, id, threadId);
    else if ('status' in input) await setThreadStatus(db(), user.id, id, threadId, input.status);
    else {
      const made = await reply(db(), user.id, id, threadId, input);
      const paper = await getProject(db(), user.id, id);
      await tellMentioned(made.mentioned, user.email, paper.name, id, made.fileId);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return failed(err);
  }
}
