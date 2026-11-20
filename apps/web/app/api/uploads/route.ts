// Where the browser may put a ZIP or a file. Vercel takes no more than 4.5 MB in a request, so
// uploads go from the browser to the store, at an address made here for the one who asked and
// good for ten minutes. The import and the file routes then take what was put there.
import { AppError, startUpload } from '@paperweave/server';
import { blobs, currentUser, db, readJson, sameOrigin } from '../../../lib/server';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  const asked = await readJson(request);
  const size = typeof asked?.size === 'number' ? asked.size : undefined;
  try {
    const what =
      asked?.kind === 'zip'
        ? ({ kind: 'zip' } as const)
        : asked?.kind === 'file'
          ? ({ kind: 'file', projectId: String(asked.projectId) } as const)
          : null;
    if (!what) return Response.json({ error: 'Say what is being uploaded.' }, { status: 400 });
    const made = await startUpload(db(), blobs(), user.id, what, size);
    return Response.json(made, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
