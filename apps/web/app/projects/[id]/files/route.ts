// Add a file to a paper: an empty text file, or an upload. A route handler, not a form action,
// because uploads are larger than a form action may be.
import { AppError, createFile, LIMITS } from '@paperweave/server';
import { blobs, currentUser, db, sameOrigin } from '../../../../lib/server';

const to = (request: Request, path: string) => Response.redirect(new URL(path, request.url), 303);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const back = `/projects/${encodeURIComponent((await params).id)}`;
  const user = await currentUser();
  if (!user) return to(request, `/sign-in?next=${encodeURIComponent(back)}`);
  const failed = (message: string) => to(request, `${back}?error=${encodeURIComponent(message)}`);
  // Refuse an oversized upload before reading it. The file itself is checked again inside.
  if (Number(request.headers.get('content-length') ?? 0) > LIMITS.fileBytes + 1_000_000)
    return failed('That file is too large.');
  const form = await request.formData().catch(() => null);
  const upload = form?.get('file');
  const file = upload instanceof File && upload.size ? upload : null;
  const path = String(form?.get('path') ?? '').trim() || file?.name;
  if (!path) return failed('Give the file a name, or choose a file to upload.');
  try {
    await createFile(
      db(),
      blobs(),
      user.id,
      (await params).id,
      path,
      file ? new Uint8Array(await file.arrayBuffer()) : undefined,
    );
    return to(request, `${back}?added=${encodeURIComponent(path)}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    // Not a member, or no such paper: the page itself answers that with "not found".
    return err.code === 'not_found' ? to(request, back) : failed(err.message);
  }
}
