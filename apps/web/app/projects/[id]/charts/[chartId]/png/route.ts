// A drawn chart as a picture, for the chart's own page.
import { AppError, chartPngDigest } from '@paperweave/server';
import { currentUser, db, sendBlob } from '../../../../../../lib/server';

// Vercel stops the function after this many seconds. Asking the store how large the picture is.
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; chartId: string }> },
) {
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  const { id, chartId } = await params;
  try {
    const digest = await chartPngDigest(db(), user.id, id, chartId);
    return await sendBlob(request, digest, {
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      // next.config.ts is what sends this: a header already on the answer wins over this one.
      'content-security-policy': "default-src 'none'; sandbox",
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
