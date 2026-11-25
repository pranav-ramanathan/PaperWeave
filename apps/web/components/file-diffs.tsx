import { diffHunks, type diffRevisions } from '@paperweave/server';
import { Fragment } from 'react';

type Diff = Awaited<ReturnType<typeof diffRevisions>>;
const WHAT = { added: 'Added', removed: 'Removed', changed: 'Changed', renamed: 'Renamed' };
type FileDiffLines = Parameters<typeof diffHunks>[0];
const lines = (n: number) => `${n} unchanged line${n === 1 ? '' : 's'}`;
const MARK = { '+': 'added', '-': 'removed', ' ': 'kept' } as const;

/**
 * What changed in each file between two revisions: the markup of the comparison page, shared by it
 * and the history page. `other` is the id of the older revision and `rev` of the newer; `Heading`
 * is the level of each file's heading.
 */
export function FileDiffs({
  id,
  diff,
  other,
  rev,
  Heading = 'h2',
}: {
  id: string;
  diff: Diff;
  other: string;
  rev: string;
  Heading?: 'h2' | 'h3' | 'h4';
}) {
  return (
    <>
      {diff.files.map((f) => {
        // The one revision that holds an added or removed file, and its number.
        const [one, number] = f.status === 'removed' ? [other, diff.from] : [rev, diff.to];
        return (
          <section key={f.path} aria-label={f.path}>
            <Heading>
              <code>{f.path}</code> <span className="role">{WHAT[f.status]}</span>
              {f.was && (
                <span className="role">
                  {' '}
                  (was <code>{f.was}</code>)
                </span>
              )}
            </Heading>
            {f.lines ? (
              f.lines.length === 0 && !f.more ? (
                <p>This file is empty.</p>
              ) : (
                <>
                  {f.lines.length > 0 && <Changes path={f.path} lines={f.lines} />}
                  {f.more ? (
                    <p>
                      {f.more} more line{f.more === 1 ? '' : 's'} of this file{' '}
                      {f.more === 1 ? 'is' : 'are'} not shown here.
                      {!f.held && (
                        <>
                          {' '}
                          To read {f.more === 1 ? 'it' : 'them'}, download{' '}
                          <a href={`/projects/${id}/revisions/${one}/zip`}>
                            the ZIP of revision {number}
                          </a>
                          .
                        </>
                      )}
                    </p>
                  ) : null}
                </>
              )
            ) : f.tooLarge && (f.status === 'added' || f.status === 'removed') ? (
              <p>
                This file is too large to show here.
                {!f.held && (
                  <>
                    {' '}
                    To read it, download{' '}
                    <a href={`/projects/${id}/revisions/${one}/zip`}>
                      the ZIP of revision {number}
                    </a>
                    .
                  </>
                )}
              </p>
            ) : f.tooLarge ? (
              <p>
                Too much of this file changed to show it line by line here. To compare them,
                download{' '}
                <a href={`/projects/${id}/revisions/${other}/zip`}>
                  the ZIP of revision {diff.from}
                </a>{' '}
                and{' '}
                <a href={`/projects/${id}/revisions/${rev}/zip`}>the ZIP of revision {diff.to}</a>.
              </p>
            ) : f.status === 'changed' ? (
              <p>This file changed, but it is not text that can be shown line by line.</p>
            ) : (
              (f.status === 'added' || f.status === 'removed') && (
                <p>This file is not text that can be shown here.</p>
              )
            )}
          </section>
        );
      })}
    </>
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
