// Download the paper's files as a ZIP. With ?review, its threads and proposed changes go in too,
// as a file of their own.
import { AppError, exportZip, getProject } from '@paperweave/server';
import { blobs, currentUser, db } from '../../../../lib/server';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  try {
    const project = await getProject(db(), user.id, id);
    const review = new URL(request.url).searchParams.has('review');
    const zip = await exportZip(db(), blobs(), user.id, id, { review });
    // Only plain characters in the file name: it goes into a header.
    const name = project.name.replace(/[^\w .-]+/g, '_').slice(0, 80) || 'paper';
    return new Response(zip as BodyInit, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${name}.zip"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
