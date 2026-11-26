import {
  AppError,
  bblInRevision,
  withScope,
  can,
  type Finding,
  byCause,
  type Placed,
  heldInRevisions,
  heldLine,
  submissionChecks,
  unusedInRevision,
} from '@paperweave/server';
import Again from '../../../Again';
import Result from '../../../Result';
import Link from '../../../Go';
import Once from '../../../Once';
import { notFound } from 'next/navigation';
import { blobs, db, forTitle, paperOf, requireUser } from '../../../../lib/server';
import { buildNowAction } from '../../actions';
import { FormPage, Say } from '../../../../components/form-page';

export const dynamic = 'force-dynamic';

/** Everything known to be wrong with the paper, and its files once nothing is. */
async function Submit({
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
    paperOf(user.id, id),
    submissionChecks(db(), blobs(), user.id, id),
  ]).catch((err) => {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  const of = (level: Finding['level']) => checks.findings.filter((f) => f.level === level);
  // One place, as the editor opens it.
  const where = (p: Placed['places'][number]) =>
    p.fileId ? (
      // The editor goes to a line it is given.
      <Link
        prefetch={false}
        href={`/projects/${id}/files/${p.fileId}${p.line ? `?line=${p.line}` : ''}`}
      >
        {p.path}
        {p.line ? `, line ${p.line}` : ''}
      </Link>
    ) : (
      <>
        <code>{p.path}</code>
        {p.line ? `, line ${p.line}` : ''}
      </>
    );
  const list = (found: Finding[]) => (
    <ul className="report">
      {byCause(found).map((f, i) => (
        <li key={i}>
          {f.message}{' '}
          {f.places.length > 1 ? (
            <>
              {f.places.slice(0, 5).map((p, j) => (
                <span key={j}>
                  {j > 0 && ', '}
                  {where(p)}
                </span>
              ))}
              {f.places.length > 5 && ` and ${f.places.length - 5} more places.`}
            </>
          ) : f.fileId || f.path ? (
            where({ fileId: f.fileId, path: f.path, line: f.line })
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
  // The ZIP of only the files the paper uses differs from the plain one when it leaves a file
  // out or holds the .bbl the build read.
  const anyUnused =
    checks.ready && checks.revisionId
      ? (await unusedInRevision(db(), user.id, id, checks.revisionId)).length > 0 ||
        (await bblInRevision(db(), user.id, id, checks.revisionId)) !== null
      : false;
  const revision = `/projects/${id}/revisions/${checks.revisionId}`;
  return (
    <FormPage
      wide
      // While a build runs, look again every two seconds.
      before={checks.building && <Again />}
      title={<>Check {project.name} before submitting</>}
      back={
        <Link prefetch={false} href={`/projects/${id}`}>
          Back to the paper
        </Link>
      }
    >
      {error && <Result alert>{error}</Result>}
      {checks.ready ? (
        <>
          <Say role="status" tone="success">
            Nothing stands in the way. The ZIP and the PDF below are of the same revision.
          </Say>
          {can(project.role, 'project.export') ? (
            <p>
              <a href={`${revision}/zip`}>Download the ZIP</a>{' '}
              <a href={`${revision}/zip?manifest`}>Download the ZIP with a toolchain manifest</a>{' '}
              {anyUnused && (
                <>
                  <a href={`${revision}/zip?used`}>
                    Download the ZIP of only the files the paper uses
                  </a>{' '}
                </>
              )}
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
          <Once type="submit">Build the paper and check again</Once>
        </form>
      )}
    </FormPage>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await forTitle((userId) => paperOf(userId, id));
  return { title: `Check before submitting${project ? ` · ${project.name}` : ''}` };
}

// What this page reads about the paper, it reads once.
export default function Scoped(props: Parameters<typeof Submit>[0]) {
  return withScope(() => Submit(props));
}
