import { findInvitation } from '@paperweave/server';
import Link from 'next/link';
import { db, requireUser } from '../../../lib/server';
import { joinAction } from '../../projects/actions';

export const dynamic = 'force-dynamic';

export default async function Invitation({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const user = await requireUser(`/invitations/${token}`);
  const invitation = await findInvitation(db(), token);
  const { error } = await searchParams;
  if (!invitation)
    return (
      <main className="page narrow">
        <h1>This invitation is not valid any more</h1>
        <p>
          It may have been used already or have expired. Ask the paper&rsquo;s owner for a new one.
        </p>
        <Link prefetch={false} href="/projects">
          Your papers
        </Link>
      </main>
    );
  return (
    <main className="page narrow">
      <h1>Join &ldquo;{invitation.project}&rdquo;</h1>
      {error && <p role="alert">{error}</p>}
      <p>
        You were invited as {invitation.role === 'editor' ? 'an' : 'a'} {invitation.role}. You are
        signed in as {user.email}.
      </p>
      <form action={joinAction.bind(null, token)}>
        <button type="submit">Join this paper</button>
      </form>
    </main>
  );
}
