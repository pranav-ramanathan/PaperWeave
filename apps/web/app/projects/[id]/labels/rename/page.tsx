import { AppError, proposeLabelRename } from '@paperweave/server';
import Result from '../../../../Result';
import Link from '../../../../Go';
import Once from '../../../../Once';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../../lib/server';
import { FormPage, Say } from '../../../../../components/form-page';
import { renameLabelAction } from '../../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Rename a label' };

/** What renaming a label would change, shown before anything is changed. */
export default async function RenameLabel({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string; error?: string }>;
}) {
  const { id } = await params;
  const { from = '', to = '', error } = await searchParams;
  const here = `/projects/${id}/labels/rename?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const user = await requireUser(here);
  const proposal = await proposeLabelRename(db(), blobs(), user.id, id, from, to).catch((err) => {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'not_found') notFound();
    return err.message;
  });
  const back = (
    <Link prefetch={false} href={`/projects/${id}#labels`}>
      Back to the paper
    </Link>
  );
  if (typeof proposal === 'string')
    return (
      <FormPage title="Rename a label" back={back}>
        <Say role="alert">{proposal}</Say>
      </FormPage>
    );
  const files = [...new Set(proposal.changes.map((c) => c.path))];
  const places = proposal.changes.length;
  return (
    <FormPage
      wide
      title={
        <>
          Rename <code>{proposal.from}</code> to <code>{proposal.to}</code>
        </>
      }
      back={back}
    >
      {error && <Result alert>{error}</Result>}
      <p>
        This would change {places} {places === 1 ? 'line' : 'lines'} in {files.length}{' '}
        {files.length === 1 ? 'file' : 'files'}: the label itself and every reference to it. Nothing
        has been changed yet.
      </p>
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
      <form action={renameLabelAction.bind(null, id)}>
        <input type="hidden" name="from" value={proposal.from} />
        <input type="hidden" name="to" value={proposal.to} />
        <input type="hidden" name="digest" value={proposal.digest} />
        <Once type="submit">
          Rename in all {files.length === 1 ? 'of it' : `${files.length} files`}
        </Once>
      </form>
    </FormPage>
  );
}
