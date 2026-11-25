import { invitationToken, invitedAddress } from '@paperweave/server';
import { redirect } from 'next/navigation';
import { Notice } from '../../components/notice';
import { SmallPage } from '../../components/small-page';
import { currentUser, db, safePath } from '../../lib/server';
import { ui } from '../../lib/ui';
import SignInForm from './SignInForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; link?: string }>;
}) {
  const { next, error, link } = await searchParams;
  const to = safePath(next);
  // Sign-in sends a link that does not work back here with a code for what was wrong. The
  // code is not shown, nor left in the address: it is swapped for a plain flag.
  if (error) redirect(`/sign-in?link=used&next=${encodeURIComponent(to)}`);
  if (await currentUser()) redirect(to);
  // Someone following an invitation before signing in is told that this is where it led, and
  // which address to use: any other address ends, two emails later, at "for someone else".
  // Undefined: not an invitation, or it could not be read, and the page is as for anyone.
  const token = invitationToken(to);
  const invited = token ? await invitedAddress(db(), token).catch(() => undefined) : undefined;
  const look = await ui('sign-in');
  const used = 'That sign-in link has been used or has expired. Ask for a new one below.';
  return (
    <SmallPage look={look}>
      <h1>Sign in to PaperWeave</h1>
      {link === 'used' &&
        (look === 'next' ? <Notice kind="error">{used}</Notice> : <p role="alert">{used}</p>)}
      {invited && (
        <p>
          You have been invited to a paper on PaperWeave. The invitation is for{' '}
          <strong>{invited}</strong>: sign in with that address, and the next page lets you join the
          paper.
        </p>
      )}
      {invited === null && (
        <p>
          This invitation is not valid any more. It may have been used already or have expired. If
          you have already joined the paper, sign in to open it; if not, ask the paper&rsquo;s owner
          for a new invitation.
        </p>
      )}
      <p>Enter your email address and we will send you a link. There is no password.</p>
      <SignInForm next={invited === null ? '/projects' : to} />
    </SmallPage>
  );
}
