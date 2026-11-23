import { AppError, diffHunks, diffRevisions } from '@paperweave/server';
import Link from '../../../../../../Go';
import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../../../../lib/server';

export const dynamic = 'force-dynamic';
const WHAT = { added: 'Added', removed: 'Removed', changed: 'Changed', renamed: 'Renamed' };
type FileDiffLines = Parameters<typeof diffHunks>[0];
const lines = (n: number) => `${n} unchanged line${n === 1 ? '' : 's'}`;
const MARK = { '+': 'added', '-': 'removed', ' ': 'kept' } as const;

// Only the two numbers in the address, which say nothing the address does not: the paper's name
// would cost a read of its own.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ rev: string; other: string }>;
}) {
  const { rev, other } = await params;
  const n = (s: string) => (/^\d{1,9}$/.test(s) ? s : '?');
  return { title: `Revision ${n(other)} to revision ${n(rev)}` };
}

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
            <Changes path={f.path} lines={f.lines} />
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

// Only the changed lines, with a few around each and a count of what is left out. The + and - at
// the start of each line carry the meaning; the shading only helps. A word that changed is in
// <del> or <ins>. Lines wrap, but the block keeps a name and a tab stop (see Wide.tsx).
function Changes({ path, lines: all }: { path: string; lines: NonNullable<FileDiffLines> }) {
  const { hunks, rest } = diffHunks(all);
  if (hunks.length === 0)
    return <p>No line of this file&apos;s text differs: only its line endings or encoding do.</p>;
  return (
    <pre className="diff" role="region" aria-label={`Changes to ${path}`} tabIndex={0}>
      {hunks.map((h, i) => (
        <Fragment key={i}>
          <span className="gap">
            {h.skipped > 0 ? `${lines(h.skipped)}, then line ${h.line}:` : `Line ${h.line}:`}
            {'\n'}
          </span>
          {h.rows.map((r, j) => (
            <span key={j} className={r.words ? `${MARK[r.op]} part` : MARK[r.op]}>
              {r.op}{' '}
              {r.words
                ? r.words.map((w, k) =>
                    !w.changed ? (
                      w.text
                    ) : r.op === '-' ? (
                      <del key={k}>{w.text}</del>
                    ) : (
                      <ins key={k}>{w.text}</ins>
                    ),
                  )
                : r.text}
              {'\n'}
            </span>
          ))}
        </Fragment>
      ))}
      {rest > 0 && (
        <span className="gap">
          {lines(rest)} after this.
          {'\n'}
        </span>
      )}
    </pre>
  );
}
