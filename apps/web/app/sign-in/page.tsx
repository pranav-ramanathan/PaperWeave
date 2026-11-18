import { redirect } from 'next/navigation';
import { currentUser, safePath } from '../../lib/server';
import SignInForm from './SignInForm';

export const dynamic = 'force-dynamic';

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const to = safePath(next);
  if (await currentUser()) redirect(to);
  return (
    <main className="page narrow">
      <h1>Sign in to PaperWeave</h1>
      {error && <p role="alert">That sign-in link is no longer valid. Ask for a new one.</p>}
      <p>Enter your email address and we will send you a link. There is no password.</p>
      <SignInForm next={to} />
    </main>
  );
}
