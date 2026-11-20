import { AppError, proposeFileRename } from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../../../lib/server';
import { renameFileAction } from '../../../../actions';

export const dynamic = 'force-dynamic';

/** The lines that name a file, and what they would say once it is renamed. Nothing is changed. */
export default async function RenameFile({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; fileId: string }>;
  searchParams: Promise<{ to?: string; error?: string }>;
}) {
  const { id, fileId } = await params;
  const { to = '', error } = await searchParams;
  const user = await requireUser(
    `/projects/${id}/files/${fileId}/rename?to=${encodeURIComponent(to)}`,
  );
  const proposal = await proposeFileRename(db(), blobs(), user.id, id, fileId, to).catch((err) => {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'not_found') notFound();
    return err.message;
  });
  const back = (
    <Link prefetch={false} href={`/projects/${id}`}>
      Back to the paper
    </Link>
  );
  if (typeof proposal === 'string')
    return (
      <main className="page">
        <header className="bar">
          <h1>Rename a file</h1>
          {back}
        </header>
        <p role="alert">{proposal}</p>
      </main>
    );
  const files = [...new Set(proposal.changes.map((c) => c.path))];
  const lines = proposal.changes.length;
  return (
    <main className="page">
      <header className="bar">
        <h1>
          Rename <code>{proposal.from}</code> to <code>{proposal.to}</code>
        </h1>
        {back}
      </header>
      {error && <p role="alert">{error}</p>}
      {lines === 0 ? (
        <p>
          No line that this page can see names <em>{proposal.from}</em>. A package, class,
          bibliography style, listing or data file can be named in ways it does not read (
          <code>\usepackage</code>, <code>\documentclass</code>, <code>\lstinputlisting</code> and
          the like). If the paper names this file that way, change that line yourself, and check
          that the paper still builds. Nothing has been changed yet.
        </p>
      ) : (
        <p>
          {lines} {lines === 1 ? 'line names' : 'lines name'} this file. Renaming it would change{' '}
          {lines === 1 ? 'that line' : 'those lines'} too. Nothing has been changed yet.
        </p>
      )}
      {files.map((path) => (
        <section key={path} aria-label={path}>
          <h2>
            <code>{path}</code>
          </h2>
          {/* The - and + at the start of each line carry the meaning; the shading only helps. */}
          <pre className="diff">
            {proposal.changes
              .filter((c) => c.path === path)
              .map((c) => (
                <span key={c.line}>
                  <span className="removed">
                    - {c.line}: {c.before}
                    {'\n'}
                  </span>
                  <span className="added">
                    + {c.line}: {c.after}
                    {'\n'}
                  </span>
                </span>
              ))}
          </pre>
        </section>
      ))}
      <form action={renameFileAction.bind(null, id, fileId)}>
        <input type="hidden" name="to" value={proposal.to} />
        <input type="hidden" name="digest" value={proposal.digest} />
        <button type="submit" name="how" value="all">
          {lines === 0
            ? 'Rename'
            : `Rename and update ${lines === 1 ? 'that line' : `those ${lines} lines`}`}
        </button>{' '}
        {lines > 0 && (
          <button type="submit" name="how" value="only">
            Rename only. The paper will not build until those lines are fixed.
          </button>
        )}
      </form>
    </main>
  );
}
