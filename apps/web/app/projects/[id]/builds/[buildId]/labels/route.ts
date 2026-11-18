// The number LaTeX gave each label in one build, for showing beside references in the editor.
import { AppError, buildLabels } from '@paperweave/server';
import { currentUser, db } from '../../../../../../lib/server';

type Params = { params: Promise<{ id: string; buildId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id, buildId } = await params;
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    return Response.json(await buildLabels(db(), user.id, id, buildId), {
      // A build never changes, but it is private to the people on the paper.
      headers: { 'cache-control': 'private, max-age=3600' },
    });
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
