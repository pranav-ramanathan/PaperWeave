import { redirect } from 'next/navigation';
import { currentUser, safePath } from '../../lib/server';
import SignInForm from './SignInForm';

export const dynamic = 'force-dynamic';

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
  return (
    <main className="page narrow">
      <h1>Sign in to PaperWeave</h1>
      {link === 'used' && (
        <p role="alert">That sign-in link has been used or has expired. Ask for a new one below.</p>
      )}
      <p>Enter your email address and we will send you a link. There is no password.</p>
      <SignInForm next={to} />
    </main>
  );
}
