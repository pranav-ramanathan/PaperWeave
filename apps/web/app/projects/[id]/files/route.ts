// Add a file to a paper: an empty text file, or an upload. A route handler, not a form action,
// because uploads are larger than a form action may be. The browser puts an upload into the store
// itself (app/api/uploads) and posts only its `key` and the file's name here, because a function
// takes no more than 4.5 MB in a request. A file posted whole, as `file`, is still taken, up to
// the same limit: for a browser with no scripts, and for local work.
import {
  AppError,
  addUploaded,
  createFile,
  LIMITS,
  listFiles,
  replaceFile,
  restoreThatRemoved,
} from '@paperweave/server';
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
  // Ticked: the upload takes the place of the file of this name, and keeps that file's ID.
  const replace = form?.get('replace') !== null && form?.get('replace') !== undefined;
  if (replace && typeof key !== 'string' && !file)
    return failed('Choose the file that is to take the place of the old one.');
  try {
    if (typeof key === 'string')
      await addUploaded(db(), blobs(), user.id, (await params).id, key, path, LIMITS, replace);
    else if (replace)
      await replaceFile(
        db(),
        blobs(),
        user.id,
        (await params).id,
        path,
        new Uint8Array(await file!.arrayBuffer()),
      );
    else
      await createFile(
        db(),
        blobs(),
        user.id,
        (await params).id,
        path,
        file ? new Uint8Array(await file.arrayBuffer()) : undefined,
      );
    return seeOther(`${back}?added=${encodeURIComponent(path)}${replace ? '&replaced=1' : ''}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    // Not a member, or no such paper: the page itself answers that with "not found".
    return err.code === 'not_found' ? seeOther(back) : failed(err.message);
  }
}

/**
 * The paper's files, for an open editor that was told the list changed: each file's ID, path and
 * whether it can be opened as text; and who is asking, so that a page left open by one person
 * shows nothing of what the next person to sign in on the browser may see. An editor whose file
 * is no longer served names it (`gone`), and is told of the restore that took it out, if one did.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const { id } = await params;
  try {
    // Refuses anyone who is not on the paper, before anything of it is read.
    const files = await listFiles(db(), user.id, id);
    const gone = new URL(request.url).searchParams.get('gone');
    return Response.json(
      {
        user: user.email,
        files: files.map((f) => ({ id: f.id, path: f.path, readonly: f.readonly })),
        restore: gone ? await restoreThatRemoved(db(), id, gone) : null,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return Response.json({ error: 'No such paper.' }, { status: 404 });
  }
}
