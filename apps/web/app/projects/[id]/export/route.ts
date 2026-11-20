// Download the paper's files as a ZIP. With ?review, its threads and proposed changes go in too,
// as a file of their own.
import { AppError, contentDisposition, exportZipStream, getProject } from '@paperweave/server';
import { blobs, currentUser, db } from '../../../../lib/server';

// Vercel stops the function after this many seconds. Reading every file and zipping it.
export const maxDuration = 120;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  try {
    const project = await getProject(db(), user.id, id);
    const review = new URL(request.url).searchParams.has('review');
    const zip = await exportZipStream(db(), blobs(), user.id, id, { review });
    return new Response(zip, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': contentDisposition(project.name, 'zip'),
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
