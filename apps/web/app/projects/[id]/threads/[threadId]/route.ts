// Answer a thread ({body, mentions}), resolve it or open it again ({status}), attach it to its
// words again ({attach}), or change ({comment, body}) or delete ({comment, delete: true}) a comment.
import {
  AppError,
  deleteComment,
  editComment,
  getProject,
  reattachThread,
  reply,
  setThreadStatus,
} from '@paperweave/server';
import { blobs, currentUser, db, readJson, sameOrigin } from '../../../../../lib/server';
import { failed, MENTION_LIMIT_NOTE, tellMentioned } from '../mentions';

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
    let note: string | undefined;
    if ('attach' in input) await reattachThread(db(), blobs(), user.id, id, threadId);
    else if ('status' in input) await setThreadStatus(db(), user.id, id, threadId, input.status);
    else if ('comment' in input)
      await (input.delete === true
        ? deleteComment(db(), user.id, id, threadId, String(input.comment))
        : editComment(db(), user.id, id, threadId, String(input.comment), input));
    else {
      const made = await reply(db(), user.id, id, threadId, input);
      const paper = await getProject(db(), user.id, id);
      tellMentioned(made.mentioned, user.email, paper.name, id, made.fileId, threadId);
      if (made.limited) note = MENTION_LIMIT_NOTE;
    }
    return Response.json({ ok: true, ...(note && { note }) });
  } catch (err) {
    return failed(err);
  }
}
