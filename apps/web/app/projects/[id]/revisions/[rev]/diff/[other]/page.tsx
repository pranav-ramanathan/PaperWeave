import { AppError, diffRevisions } from '@paperweave/server';
import Link from '../../../../../../Go';
import { FileDiffs } from '../../../../../../../components/file-diffs';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../../../../lib/server';
import { FormPage } from '../../../../../../../components/form-page';
import { ui } from '../../../../../../../lib/ui';

export const dynamic = 'force-dynamic';

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
  const look = await ui('revisions-diff');
  return (
    <FormPage
      look={look}
      wide
      title={
        <>
          Revision {diff.from} to revision {diff.to}
        </>
      }
      back={
        <Link prefetch={false} href={`/projects/${id}`}>
          Paper overview
        </Link>
      }
    >
      {diff.files.length === 0 && <p>Nothing differs between these two revisions.</p>}
      <FileDiffs id={id} diff={diff} other={other} rev={rev} />
    </FormPage>
  );
}
