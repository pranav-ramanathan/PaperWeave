// Turn a ZIP, or a .tar.gz, .tgz or .tar (which one it is, is told by its bytes, not its name)
// into a paper. A route handler, not a form action, because archives are far larger
// than a form action may be. The browser puts the ZIP into the store itself (app/api/uploads) and
// posts only its `key` here, because a function takes no more than 4.5 MB in a request. A ZIP
// posted whole, as `zip`, is still taken, up to the same limit: for a browser with no scripts, and
// for local work.
import { AppError, importUploaded, importZip, LIMITS } from '@paperweave/server';
import { blobs, bounded, currentUser, db, sameOrigin, seeOther } from '../../../../lib/server';

// Vercel stops the function after this many seconds. Reading and unpacking a ZIP.
export const maxDuration = 120;

const failed = (message: string) => seeOther(`/projects?error=${encodeURIComponent(message)}`);

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return seeOther('/sign-in?next=%2Fprojects');
  // Refuse an oversized upload before reading it. The archive itself is checked again inside.
  if (Number(request.headers.get('content-length') ?? 0) > LIMITS.archiveBytes + 1_000_000)
    return failed('This ZIP cannot be imported: it is too large.');
  // And while reading it: the length a request claims is only a claim.
  const body = await bounded(request, LIMITS.archiveBytes + 1_000_000);
  if (!body) return failed('This ZIP cannot be imported: it is too large.');
  const form = await body.formData().catch(() => null);
  const key = form?.get('key');
  const file = form?.get('zip');
  if (typeof key !== 'string' && (!(file instanceof File) || !file.size))
    return failed('Choose a ZIP file to import.');
  try {
    const name = (typeof key === 'string' ? String(form?.get('name') ?? '') : (file as File).name)
      .replace(/\.(zip|tar\.gz|tgz|tar)$/i, '')
      .slice(0, 200);
    const made = await (typeof key === 'string'
      ? importUploaded(db(), blobs(), user.id, key, name)
      : importZip(
          db(),
          blobs(),
          user.id,
          new Uint8Array(await (file as File).arrayBuffer()),
          name,
        ));
    return seeOther(
      made.length === 1 ? `/projects/${made[0].id}` : `/projects?imported=${made.length}`,
    );
  } catch (err) {
    if (err instanceof AppError) return failed(err.message);
    throw err;
  }
}
