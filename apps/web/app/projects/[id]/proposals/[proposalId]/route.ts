// Decide a proposed edit, or change it: {action: accept | undo | reject | withdraw | revise | attach}.
import {
  acceptProposal,
  AppError,
  closeProposal,
  reattachProposal,
  reviseProposal,
  undoAccept,
} from '@paperweave/server';
import { blobs, currentUser, db, readJson, sameOrigin } from '../../../../../lib/server';

/**
 * The two places an attach may carry, as bytes; none when it carries none. The editor writes
 * them in the URL-safe alphabet (- and _, no padding), and Buffer reads that as well as the
 * standard one. Both or neither.
 */
function placesOf(input: object) {
  const { from, to } = input as { from?: unknown; to?: unknown };
  if (from === undefined && to === undefined) return undefined;
  const bytes = (v: unknown) => {
    if (typeof v !== 'string' || !v || v.length > 200 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(v))
      throw new AppError('invalid_input', 'That place in the text is not valid.');
    return new Uint8Array(Buffer.from(v, 'base64'));
  };
  return { from: bytes(from), to: bytes(to) };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; proposalId: string }> },
) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const { id, proposalId } = await params;
  try {
    const input = await readJson(request);
    const action: unknown = input && typeof input === 'object' ? input.action : null;
    const seen: unknown = input && typeof input === 'object' ? input.seen : undefined;
    if (action === 'accept') await acceptProposal(db(), blobs(), user.id, id, proposalId, seen);
    else if (action === 'undo') await undoAccept(db(), blobs(), user.id, id, proposalId);
    else if (action === 'reject')
      await closeProposal(db(), user.id, id, proposalId, 'rejected', seen);
    else if (action === 'withdraw') await closeProposal(db(), user.id, id, proposalId, 'dismissed');
    else if (action === 'revise')
      await reviseProposal(db(), blobs(), user.id, id, proposalId, input);
    else if (action === 'attach')
      await reattachProposal(db(), blobs(), user.id, id, proposalId, placesOf(input as object));
    else throw new AppError('invalid_input', 'That cannot be done to a proposal.');
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
