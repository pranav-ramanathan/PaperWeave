'use server';

import { cookiesToSet } from '@paperweave/server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, safePath } from '../../../lib/server';

/**
 * The button on the confirm page. Only this, a POST that a mail scanner does not make, uses up
 * the emailed token and starts a session. Whatever goes wrong is said as "used or expired".
 */
export async function confirmSignInAction(form: FormData) {
  const token = String(form.get('token') ?? '');
  const to = safePath(form.get('next'));
  const used = `/sign-in?link=used&next=${encodeURIComponent(to)}`;
  let signedIn = false;
  try {
    const verified = await auth().api.magicLinkVerify({
      query: { token },
      headers: await headers(),
      returnHeaders: true,
    });
    const store = await cookies();
    for (const { name, value, options } of cookiesToSet(verified.headers))
      store.set(name, value, options);
    signedIn = true;
  } catch {
    // An unknown, used or expired token, or a fault: the person is told to ask for a new link.
  }
  // Outside the try: a redirect is thrown, and must not be taken for a failure.
  redirect(signedIn ? to : used);
}
