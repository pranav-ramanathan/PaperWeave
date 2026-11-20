// Add a file to a paper: an empty text file, or an upload. A route handler, not a form action,
// because uploads are larger than a form action may be. The browser puts an upload into the store
// itself (app/api/uploads) and posts only its `key` and the file's name here, because a function
// takes no more than 4.5 MB in a request. A file posted whole, as `file`, is still taken, up to
// the same limit: for a browser with no scripts, and for local work.
import { AppError, addUploaded, createFile, LIMITS } from '@paperweave/server';
import { blobs, bounded, currentUser, db, sameOrigin, seeOther } from '../../../../lib/server';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const back = `/projects/${encodeURIComponent((await params).id)}`;
  const user = await currentUser();
  if (!user) return seeOther(`/sign-in?next=${encodeURIComponent(back)}`);
  const failed = (message: string) => seeOther(`${back}?error=${encodeURIComponent(message)}`);
  // Refuse an oversized upload before reading it. The file itself is checked again inside.
  if (Number(request.headers.get('content-length') ?? 0) > LIMITS.fileBytes + 1_000_000)
    return failed('That file is too large.');
  // And while reading it: the length a request claims is only a claim.
  const body = await bounded(request, LIMITS.fileBytes + 1_000_000);
  if (!body) return failed('That file is too large.');
  const form = await body.formData().catch(() => null);
  const upload = form?.get('file');
  const file = upload instanceof File && upload.size ? upload : null;
  const key = form?.get('key');
  const path =
    String(form?.get('path') ?? '').trim() ||
    (typeof key === 'string' ? String(form?.get('name') ?? '') : file?.name);
  if (!path) return failed('Give the file a name, or choose a file to upload.');
  try {
    if (typeof key === 'string')
      await addUploaded(db(), blobs(), user.id, (await params).id, key, path);
    else
      await createFile(
        db(),
        blobs(),
        user.id,
        (await params).id,
        path,
        file ? new Uint8Array(await file.arrayBuffer()) : undefined,
      );
    return seeOther(`${back}?added=${encodeURIComponent(path)}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    // Not a member, or no such paper: the page itself answers that with "not found".
    return err.code === 'not_found' ? seeOther(back) : failed(err.message);
  }
}
