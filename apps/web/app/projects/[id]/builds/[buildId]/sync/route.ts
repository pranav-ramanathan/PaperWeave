// Between the source and a build's PDF: ?file=<id>&line=<n> gives a place on a page, and
// ?page=<n>&x=<pt>&y=<pt> gives a file and a line.
import { AppError, pdfToSource, sourceToPdf } from '@paperweave/server';
import { blobs, currentUser, db } from '../../../../../../lib/server';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; buildId: string }> },
) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const { id, buildId } = await params;
  const q = new URL(request.url).searchParams;
  const n = (name: string) => Number(q.get(name) ?? NaN);
  try {
    const found = q.has('file')
      ? await sourceToPdf(db(), blobs(), user.id, id, buildId, q.get('file')!, n('line'))
      : await pdfToSource(db(), blobs(), user.id, id, buildId, n('page'), n('x'), n('y'));
    // A build never changes, but it is private to the people on the paper.
    return Response.json(found, { headers: { 'cache-control': 'private, max-age=3600' } });
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
