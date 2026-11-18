// Decide a proposed edit, or change it: {action: accept | undo | reject | withdraw | revise}.
import {
  acceptProposal,
  AppError,
  closeProposal,
  reviseProposal,
  undoAccept,
} from '@paperweave/server';
import { blobs, currentUser, db, readJson, sameOrigin } from '../../../../../lib/server';

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
    if (action === 'accept') await acceptProposal(db(), blobs(), user.id, id, proposalId);
    else if (action === 'undo') await undoAccept(db(), blobs(), user.id, id, proposalId);
    else if (action === 'reject') await closeProposal(db(), user.id, id, proposalId, 'rejected');
    else if (action === 'withdraw') await closeProposal(db(), user.id, id, proposalId, 'dismissed');
    else if (action === 'revise')
      await reviseProposal(db(), blobs(), user.id, id, proposalId, input);
    else throw new AppError('invalid_input', 'That cannot be done to a proposal.');
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
