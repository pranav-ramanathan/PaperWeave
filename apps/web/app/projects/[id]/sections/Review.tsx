import type { listProposals, listThreads } from '@paperweave/server';
import Link from '../../../Go';

type Threads = Awaited<ReturnType<typeof listThreads>>;
type Proposals = Awaited<ReturnType<typeof listProposals>>;

const brief = (text: string) => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

/** Open threads and proposed changes, with a link to each. */
export function Review({
  id,
  openThreads,
  openProposals,
  show,
}: {
  id: string;
  openThreads: Threads;
  openProposals: Proposals;
  show: boolean;
}) {
  return (
    <>
      {show && (
        <>
          <h2 id="review" tabIndex={-1}>
            Review
          </h2>
          {openThreads.length + openProposals.length === 0 && (
            <p>Every thread is resolved and every proposed change is decided.</p>
          )}
          <ul className="report ruled">
            {openProposals.map((p) => (
              <li key={p.id} data-kind="proposal">
                <Link prefetch={false} href={`/projects/${id}/files/${p.fileId}#proposals`}>
                  {p.path}
                </Link>
                : {p.author ?? 'someone who has left'} proposes{' '}
                {p.expected ? (
                  <>
                    changing <q>{brief(p.expected)}</q> to <q>{brief(p.replacement)}</q>
                  </>
                ) : (
                  <>
                    adding <q>{brief(p.replacement)}</q>
                  </>
                )}
                .{p.stale && <strong> Out of date: the text has changed since.</strong>}
              </li>
            ))}
            {openThreads.map((t) => (
              <li key={t.id} data-kind="thread">
                <Link prefetch={false} href={`/projects/${id}/files/${t.fileId}#comments`}>
                  {t.path}
                </Link>
                : <q>{brief(t.excerpt)}</q>
                {t.state === 'detached' && <strong> (this text has been deleted)</strong>}.{' '}
                {t.comments.length} {t.comments.length === 1 ? 'comment' : 'comments'}, the latest
                by {t.comments.at(-1)?.author ?? 'someone who has left'}.
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
