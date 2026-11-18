// The paper's pictures, for choosing one to put in a figure.
import { AppError, pictures } from '@paperweave/server';
import { currentUser, db } from '../../../../lib/server';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    return Response.json(await pictures(db(), user.id, (await params).id), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
