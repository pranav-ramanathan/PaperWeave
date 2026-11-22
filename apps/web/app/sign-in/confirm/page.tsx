import { redirect } from 'next/navigation';
import Once from '../../Once';
import { safePath } from '../../../lib/server';
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
  return (
    <main className="page narrow">
      <h1>Sign in to PaperWeave</h1>
      <p>Press the button to finish signing in on this device.</p>
      <form action={confirmSignInAction}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="next" value={to} />
        <Once type="submit" autoFocus>
          Sign in
        </Once>
      </form>
    </main>
  );
}
