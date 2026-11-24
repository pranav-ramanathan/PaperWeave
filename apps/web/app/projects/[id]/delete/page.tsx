import { AppError, paperHoldings } from '@paperweave/server';
import { notFound } from 'next/navigation';
import Link from '../../../Go';
import Once from '../../../Once';
import Result from '../../../Result';
import { db, requireUser } from '../../../../lib/server';
import { deletePaperAction } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Delete a paper' };

const count = (n: number, one: string, many: string) => (n === 1 ? `one ${one}` : `${n} ${many}`);

/** What goes with a paper, shown to its owner before it is deleted. Nothing goes until the button. */
export default async function DeletePaper({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const user = await requireUser(`/projects/${id}/delete`);
  const holds = await paperHoldings(db(), user.id, id).catch((err) => {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'not_found') notFound();
    return null;
  });
  const back = (
    <Link prefetch={false} href={`/projects/${id}`}>
      Back to the paper
    </Link>
  );
  if (!holds)
    return (
      <main className="page">
        <header className="bar">
          <h1>Delete a paper</h1>
          {back}
        </header>
        <p role="alert">Only the owner of a paper can delete it.</p>
      </main>
    );
  return (
    <main className="page">
      <header className="bar">
        <h1>Delete “{holds.name}”</h1>
        {back}
      </header>
      {error && <Result alert>{error}</Result>}
      <p>
        Deleting this paper takes it away from everyone on it, at once and for good:{' '}
        {count(holds.files, 'file', 'files')}, {count(holds.revisions, 'revision', 'revisions')},
        and every build, comment, proposed change and chart.{' '}
        {holds.others === 0
          ? 'Nobody else is on the paper.'
          : `${count(holds.others, 'other person is', 'other people are')} on the paper, and will lose it too; anything they are typing when it goes is lost.`}
        {holds.invited > 0 &&
          ` ${count(holds.invited, 'invitation', 'invitations')} not yet taken up will stop working.`}
      </p>
      <p>
        It cannot be undone from here, and nobody is sent an email about it. To keep a copy,{' '}
        <a href={`/projects/${id}/export?review`}>
          download the paper as a ZIP with its review data
        </a>{' '}
        first. Nothing has been deleted yet.
      </p>
      <form action={deletePaperAction.bind(null, id)}>
        <label>
          To confirm, type the paper’s name exactly: {holds.name}
          <input name="name" required autoComplete="off" maxLength={200} />
        </label>
        <Once type="submit">Delete this paper for everyone</Once>
      </form>
    </main>
  );
}
