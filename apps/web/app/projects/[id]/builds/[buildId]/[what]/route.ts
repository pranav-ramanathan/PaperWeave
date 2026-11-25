// One output of a build: the PDF or the log.
import {
  AppError,
  buildOutputDigest,
  contentDisposition,
  getProject,
  versionOf,
} from '@paperweave/server';
import { currentUser, db, sendBlob } from '../../../../../../lib/server';

// Vercel stops the function after this many seconds. Reading one PDF or log from the store.
export const maxDuration = 60;

const TYPES = { pdf: 'application/pdf', log: 'text/plain; charset=utf-8' } as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; buildId: string; what: string }> },
) {
  const { id, buildId, what } = await params;
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  if (!(what in TYPES)) return new Response('Not found.', { status: 404 });
  try {
    const digest = await buildOutputDigest(db(), user.id, id, buildId, what as keyof typeof TYPES);
    return sendBlob(request, digest, {
      'content-type': TYPES[what as keyof typeof TYPES],
      'x-content-type-options': 'nosniff',
      // The pages embed this PDF and open it in a tab of its own: shown, not saved, but a save
      // from there is named after the paper.
      ...(what === 'pdf'
        ? {
            'content-disposition': contentDisposition(
              (await getProject(db(), user.id, id)).name,
              'pdf',
              { disposition: 'inline', version: await versionOf(db(), id) },
            ),
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
