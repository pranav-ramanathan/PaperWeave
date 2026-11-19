// The number LaTeX gave each label in one build, for showing beside references in the editor.
import { AppError, buildLabels } from '@paperweave/server';
import { askedForEachTime, currentUser, db } from '../../../../../../lib/server';

type Params = { params: Promise<{ id: string; buildId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id, buildId } = await params;
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    return askedForEachTime(
      request,
      JSON.stringify(await buildLabels(db(), user.id, id, buildId)),
      {
        'content-type': 'application/json',
      },
    );
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
