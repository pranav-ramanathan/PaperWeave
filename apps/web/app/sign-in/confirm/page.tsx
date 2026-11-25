import { redirect } from 'next/navigation';
import Once from '../../Once';
import { signInLinkAddress } from '@paperweave/server';
import { SmallPage } from '../../../components/small-page';
import { auth, safePath } from '../../../lib/server';
import { ui } from '../../../lib/ui';
import { confirmSignInAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in', robots: { index: false } };

/**
 * Where the emailed link leads. Showing this page changes nothing: mail gateways open links
 * before the person does, and must not use the link up. Pressing the button does the sign-in.
 */
export default async function Confirm({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  const to = safePath(next);
  if (!token) redirect(`/sign-in?link=used&next=${encodeURIComponent(to)}`);
  // Read only: this page must not use the token up. Whose link it is, so that someone sent
  // another person's link cannot sign a person in as them without seeing whose it is.
  const who = await signInLinkAddress(auth(), token).catch(() => null);
  const look = await ui('sign-in-confirm');
  return (
    <SmallPage look={look}>
      <h1>Sign in to PaperWeave</h1>
      {who ? (
        <p id="who">
          This signs you in as <strong>{who}</strong>. If that is not your address, do not press the
          button.
        </p>
      ) : (
        <p>Press the button to finish signing in on this device.</p>
      )}
      <form action={confirmSignInAction}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="next" value={to} />
        <Once type="submit" autoFocus aria-describedby={who ? 'who' : undefined}>
          Sign in
        </Once>
      </form>
    </SmallPage>
  );
}
