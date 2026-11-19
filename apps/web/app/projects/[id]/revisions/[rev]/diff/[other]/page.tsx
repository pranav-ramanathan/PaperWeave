import { AppError, diffRevisions } from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../../../../lib/server';

export const dynamic = 'force-dynamic';
const WHAT = { added: 'Added', removed: 'Removed', changed: 'Changed', renamed: 'Renamed' };
const MARK = { '+': 'added', '-': 'removed', ' ': 'kept' } as const;

export default async function Diff({
  params,
}: {
  params: Promise<{ id: string; rev: string; other: string }>;
}) {
  const { id, rev, other } = await params;
  const user = await requireUser(`/projects/${id}/revisions/${rev}/diff/${other}`);
  const diff = await diffRevisions(db(), blobs(), user.id, id, other, rev).catch((err) => {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  return (
    <main className="page">
      <header className="bar">
        <h1>
          Revision {diff.from} to revision {diff.to}
        </h1>
        <Link prefetch={false} href={`/projects/${id}`}>
          Paper overview
        </Link>
      </header>
      {diff.files.length === 0 && <p>Nothing differs between these two revisions.</p>}
      {diff.files.map((f) => (
        <section key={f.path} aria-label={f.path}>
          <h2>
            <code>{f.path}</code> <span className="role">{WHAT[f.status]}</span>
            {f.was && (
              <span className="role">
                {' '}
                (was <code>{f.was}</code>)
              </span>
            )}
          </h2>
          {f.lines ? (
            // The + and - at the start of each line carry the meaning; the shading only helps.
            <pre className="diff">
              {f.lines.map((l, i) => (
                <span key={i} className={MARK[l.op]}>
                  {l.op} {l.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : f.tooLarge ? (
            <p>
              Too much of this file changed to show it line by line here. To compare them, download{' '}
              <a href={`/projects/${id}/revisions/${other}/zip`}>the ZIP of revision {diff.from}</a>{' '}
              and <a href={`/projects/${id}/revisions/${rev}/zip`}>the ZIP of revision {diff.to}</a>
              .
            </p>
          ) : (
            f.status === 'changed' && (
              <p>This file changed, but it is not text that can be shown line by line.</p>
            )
          )}
        </section>
      ))}
    </main>
  );
}
