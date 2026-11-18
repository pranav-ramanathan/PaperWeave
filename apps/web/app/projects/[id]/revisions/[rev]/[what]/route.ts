// A revision's files as a ZIP, or the PDF built from exactly that revision.
import { AppError, exportRevision, revisionPdf } from '@paperweave/server';
import { blobs, currentUser, db } from '../../../../../../lib/server';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; rev: string; what: string }> },
) {
  const { id, rev, what } = await params;
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  try {
    if (what === 'pdf') {
      const pdf = await revisionPdf(db(), blobs(), user.id, id, rev);
      return new Response(pdf as BodyInit, {
        headers: { 'content-type': 'application/pdf', 'cache-control': 'private, max-age=3600' },
      });
    }
    if (what !== 'zip') return new Response('Not found.', { status: 404 });
    const manifest = new URL(request.url).searchParams.has('manifest');
    const { zip, paper, number } = await exportRevision(db(), blobs(), user.id, id, rev, manifest);
    // Only plain characters in the file name: it goes into a header.
    const name = paper.replace(/[^\w .-]+/g, '_').slice(0, 80) || 'paper';
    return new Response(zip as BodyInit, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${name} r${number}.zip"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
