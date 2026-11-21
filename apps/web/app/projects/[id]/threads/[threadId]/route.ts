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

/** The two places an attach may carry, as bytes; none when it carries none. */
function placesOf(input: object) {
  const { from, to } = input as { from?: unknown; to?: unknown };
  if (from === undefined && to === undefined) return undefined;
  const bytes = (v: unknown) => {
    if (typeof v !== 'string' || !v || v.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v))
      throw new AppError('invalid_input', 'That place in the text is not valid.');
    return new Uint8Array(Buffer.from(v, 'base64'));
  };
  return { from: bytes(from), to: bytes(to) };
}

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
    if ('attach' in input) {
      // Where the words stand now, from the tab that undid their deletion. Both or neither.
      const places = placesOf(input);
      await reattachThread(db(), blobs(), user.id, id, threadId, places);
    } else if ('status' in input) await setThreadStatus(db(), user.id, id, threadId, input.status);
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
