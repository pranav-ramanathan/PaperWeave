// A revision's files as a ZIP, or the PDF built from exactly that revision.
import {
  AppError,
  contentDisposition,
  exportRevisionStream,
  revisionPdfDigest,
  revisionTitle,
} from '@paperweave/server';
import { blobs, currentUser, db, sendBlob } from '../../../../../../lib/server';

// Vercel stops the function after this many seconds. Reading a revision and zipping it.
export const maxDuration = 120;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; rev: string; what: string }> },
) {
  const { id, rev, what } = await params;
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  try {
    if (what === 'pdf') {
      const digest = await revisionPdfDigest(db(), user.id, id, rev);
      const { paper, number } = await revisionTitle(db(), user.id, id, rev);
      return sendBlob(request, digest, {
        'content-type': 'application/pdf',
        'content-disposition': contentDisposition(paper, 'pdf', { suffix: ` r${number}` }),
      });
    }
    if (what !== 'zip') return new Response('Not found.', { status: 404 });
    const manifest = new URL(request.url).searchParams.has('manifest');
    const { zip, paper, number } = await exportRevisionStream(
      db(),
      blobs(),
      user.id,
      id,
      rev,
      manifest,
    );
    return new Response(zip, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': contentDisposition(paper, 'zip', { suffix: ` r${number}` }),
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
