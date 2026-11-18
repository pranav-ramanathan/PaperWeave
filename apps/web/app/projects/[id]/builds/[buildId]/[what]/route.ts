// One output of a build: the PDF or the log.
import { AppError, buildOutput } from '@paperweave/server';
import { blobs, currentUser, db } from '../../../../../../lib/server';

const TYPES = { pdf: 'application/pdf', log: 'text/plain; charset=latin1' } as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; buildId: string; what: string }> },
) {
  const { id, buildId, what } = await params;
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  if (!(what in TYPES)) return new Response('Not found.', { status: 404 });
  try {
    const bytes = await buildOutput(
      db(),
      blobs(),
      user.id,
      id,
      buildId,
      what as keyof typeof TYPES,
    );
    return new Response(bytes as BodyInit, {
      headers: {
        'content-type': TYPES[what as keyof typeof TYPES],
        // A build's output never changes, but it is private to the people on the paper.
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
