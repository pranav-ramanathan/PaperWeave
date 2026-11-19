// A drawn chart as a picture, for the chart's own page.
import { AppError, chartPng } from '@paperweave/server';
import { askedForEachTime, blobs, currentUser, db } from '../../../../../../lib/server';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; chartId: string }> },
) {
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  const { id, chartId } = await params;
  try {
    const png = await chartPng(db(), blobs(), user.id, id, chartId);
    return askedForEachTime(request, png, {
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
