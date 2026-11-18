// Upload a ZIP and turn it into a paper. A route handler, not a form action, because archives are
// far larger than a form action may be.
import { AppError, importZip, LIMITS } from '@paperweave/server';
import { blobs, bounded, currentUser, db, sameOrigin } from '../../../../lib/server';

const to = (request: Request, path: string) => Response.redirect(new URL(path, request.url), 303);
const failed = (request: Request, message: string) =>
  to(request, `/projects?error=${encodeURIComponent(message)}`);

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return to(request, '/sign-in?next=%2Fprojects');
  // Refuse an oversized upload before reading it. The archive itself is checked again inside.
  if (Number(request.headers.get('content-length') ?? 0) > LIMITS.archiveBytes + 1_000_000)
    return failed(request, 'This ZIP cannot be imported: it is too large.');
  // And while reading it: the length a request claims is only a claim.
  const body = await bounded(request, LIMITS.archiveBytes + 1_000_000);
  if (!body) return failed(request, 'This ZIP cannot be imported: it is too large.');
  const file = (await body.formData().catch(() => null))?.get('zip');
  if (!(file instanceof File) || !file.size) return failed(request, 'Choose a ZIP file to import.');
  try {
    const name = file.name.replace(/\.zip$/i, '');
    const made = await importZip(
      db(),
      blobs(),
      user.id,
      new Uint8Array(await file.arrayBuffer()),
      name,
    );
    return to(
      request,
      made.length === 1 ? `/projects/${made[0].id}` : `/projects?imported=${made.length}`,
    );
  } catch (err) {
    if (err instanceof AppError) return failed(request, err.message);
    throw err;
  }
}
