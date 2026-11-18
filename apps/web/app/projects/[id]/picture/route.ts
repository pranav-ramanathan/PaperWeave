// A picture of the paper, named as an \includegraphics names it, for showing in the editor.
import { AppError, picture } from '@paperweave/server';
import { blobs, currentUser, db } from '../../../../lib/server';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  const target = new URL(request.url).searchParams.get('target') ?? '';
  try {
    const found = await picture(db(), blobs(), user.id, (await params).id, target);
    return new Response(found.bytes as BodyInit, {
      headers: {
        'content-type': found.type,
        // An upload is whatever someone uploaded: it is shown as a picture and as nothing else.
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=60',
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
