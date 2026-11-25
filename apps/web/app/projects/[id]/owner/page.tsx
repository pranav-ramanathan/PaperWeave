import { AppError, getProject, listMembers } from '@paperweave/server';
import { notFound } from 'next/navigation';
import Link from '../../../Go';
import Once from '../../../Once';
import Result from '../../../Result';
import { db, requireUser } from '../../../../lib/server';
import { FormPage, Say } from '../../../../components/form-page';
import { ui } from '../../../../lib/ui';
import { transferOwnerAction } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Hand the paper to someone' };

/** Choosing a new owner, shown to the owner before the paper is handed over. Nothing changes until the button. */
export default async function HandOver({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const user = await requireUser(`/projects/${id}/owner`);
  const found = await Promise.all([getProject(db(), user.id, id), listMembers(db(), user.id, id)])
    .then(([project, members]) => ({ project, members }))
    .catch((err) => {
      if (!(err instanceof AppError)) throw err;
      if (err.code === 'not_found') notFound();
      return null;
    });
  const look = await ui('owner');
  const back = (
    <Link prefetch={false} href={`/projects/${id}`}>
      Back to the paper
    </Link>
  );
  if (!found || found.project.role !== 'owner')
    return (
      <FormPage look={look} title="Hand the paper to someone" back={back}>
        <Say look={look} role="alert">
          Only the owner of a paper can hand it to someone else.
        </Say>
      </FormPage>
    );
  const others = found.members.filter((m) => m.role !== 'owner');
  return (
    <FormPage look={look} title={<>Hand “{found.project.name}” to someone</>} back={back}>
      {error && <Result alert>{error}</Result>}
      {others.length === 0 ? (
        <p>
          Nobody else is on this paper, so there is no one to hand it to. Invite someone first, and
          they can become the owner once they have joined.
        </p>
      ) : (
        <>
          <p>
            The person you choose becomes the owner of this paper. You become an editor. You cannot
            take it back: only the new owner can make you the owner again.
          </p>
          <p>
            The new owner can remove you, change anyone’s role, invite people, and delete the paper
            for everyone. Invitations not yet taken up stay as they are. Nothing has been changed
            yet.
          </p>
          <form action={transferOwnerAction.bind(null, id)}>
            <label>
              The new owner
              <select name="member" required>
                {others.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.email}, {m.role}
                  </option>
                ))}
              </select>
            </label>
            <Once type="submit">Hand over this paper</Once>
          </form>
        </>
      )}
    </FormPage>
  );
}
