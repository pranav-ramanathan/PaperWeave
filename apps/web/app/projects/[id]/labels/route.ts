// The paper's labels, for choosing one to refer to.
import { AppError, labelReport, withScope } from '@paperweave/server';
import { blobs, currentUser, db } from '../../../../lib/server';

async function read(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    const { labels } = await labelReport(db(), blobs(), user.id, (await params).id);
    return Response.json(labels, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

// Everything this reads about the paper is asked for once.
export const GET: typeof read = (request, context) => withScope(() => read(request, context));
