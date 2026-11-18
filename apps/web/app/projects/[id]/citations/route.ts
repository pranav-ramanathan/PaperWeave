// The paper's bibliography entries and the citation command it uses, for the editor: to say
// what a citation is, to flag one with no entry, and to choose one to insert.
import { AppError, citationReport } from '@paperweave/server';
import { blobs, currentUser, db } from '../../../../lib/server';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    const { entries, command } = await citationReport(db(), blobs(), user.id, (await params).id);
    return Response.json(
      {
        entries: entries.map(({ key, description, path }) => ({ key, description, path })),
        command,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (err instanceof AppError)
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
