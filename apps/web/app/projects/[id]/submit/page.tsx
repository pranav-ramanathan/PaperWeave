import {
  AppError,
  can,
  type Finding,
  getProject,
  heldInRevisions,
  heldLine,
  submissionChecks,
} from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../lib/server';
import { buildNowAction } from '../../actions';

export const dynamic = 'force-dynamic';

/** Everything known to be wrong with the paper, and its files once nothing is. */
export default async function Submit({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const user = await requireUser(`/projects/${id}/submit`);
  const [project, checks] = await Promise.all([
    getProject(db(), user.id, id),
    submissionChecks(db(), blobs(), user.id, id),
  ]).catch((err) => {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  const of = (level: Finding['level']) => checks.findings.filter((f) => f.level === level);
  const list = (found: Finding[]) => (
    <ul className="report">
      {found.map((f, i) => (
        <li key={i}>
          {f.message}{' '}
          {f.fileId ? (
            // The editor goes to a line it is given.
            <Link
              prefetch={false}
              href={`/projects/${id}/files/${f.fileId}${f.line ? `?line=${f.line}` : ''}`}
            >
              {f.path}
              {f.line ? `, line ${f.line}` : ''}
            </Link>
          ) : f.path ? (
            <>
              <code>{f.path}</code>
              {f.line ? `, line ${f.line}` : ''}
            </>
          ) : (
            f.chartId && (
              <Link prefetch={false} href={`/projects/${id}/charts/${f.chartId}`}>
                See the chart
              </Link>
            )
          )}
        </li>
      ))}
    </ul>
  );
  const held =
    checks.ready && checks.revisionId
      ? heldLine(
          (await heldInRevisions(db(), user.id, id, [checks.revisionId])).get(checks.revisionId) ??
            [],
        )
      : null;
  const revision = `/projects/${id}/revisions/${checks.revisionId}`;
  return (
    <main className="page">
      {/* While a build runs, look again every two seconds. */}
      {checks.building && <meta httpEquiv="refresh" content="2" />}
      <header className="bar">
        <h1>Check {project.name} before submitting</h1>
        <Link prefetch={false} href={`/projects/${id}`}>
          Back to the paper
        </Link>
      </header>
      {error && <p role="alert">{error}</p>}
      {checks.ready ? (
        <>
          <p role="status">
            Nothing stands in the way. The ZIP and the PDF below are of the same revision.
          </p>
          {can(project.role, 'project.export') ? (
            <p>
              <a href={`${revision}/zip`}>Download the ZIP</a>{' '}
              <a href={`${revision}/zip?manifest`}>Download the ZIP with a toolchain manifest</a>{' '}
              <a href={`${revision}/pdf`}>Download the PDF</a>
              {held && (
                <>
                  <br />
                  <small>{held}</small>
                </>
              )}
            </p>
          ) : (
            <p>
              <a href={`${revision}/pdf`}>Download the PDF</a>
            </p>
          )}
        </>
      ) : (
        <>
          <h2>To put right</h2>
          {list(of('problem'))}
        </>
      )}
      {of('warning').length > 0 && (
        <>
          <h2>Worth a look</h2>
          {list(of('warning'))}
        </>
      )}
      {can(project.role, 'build.run') && !checks.building && (
        <form action={buildNowAction.bind(null, id)}>
          <button type="submit">Build the paper and check again</button>
        </form>
      )}
    </main>
  );
}
