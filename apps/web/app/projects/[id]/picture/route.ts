// A picture of the paper, named as an \includegraphics names it, for showing in the editor.
import { AppError, pictureDigest } from '@paperweave/server';
import { blobs, currentUser, db, sendBlob } from '../../../../lib/server';

// Vercel stops the function after this many seconds. Asking the store how large the picture is.
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  const target = new URL(request.url).searchParams.get('target') ?? '';
  try {
    const found = await pictureDigest(db(), blobs(), user.id, (await params).id, target);
    // Over 4 MB this is a redirect to the store, which then answers without the two headers
    // below; the type is signed into the address.
    return await sendBlob(request, found.digest, {
      'content-type': found.type,
      // An upload is whatever someone uploaded: it is shown as a picture and as nothing else.
      'x-content-type-options': 'nosniff',
      // next.config.ts is what sends this: a header already on the answer wins over this one.
      'content-security-policy': "default-src 'none'; sandbox",
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
