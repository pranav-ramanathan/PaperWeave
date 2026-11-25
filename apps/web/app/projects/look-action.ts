'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireUser } from '../../lib/server';
import { asLook, UI_COOKIE, UI_COOKIE_OPTIONS } from '../../lib/ui';

/**
 * The switch on the papers page ("Try the new look" and "Use the old look"): keeps the person's
 * choice in the cookie `pw_ui` and comes back to the page. Pages that are not yet in the new
 * look ignore it, so for now this changes nothing but the button's own words.
 */
export async function lookAction(form: FormData) {
  await requireUser('/projects');
  (await cookies()).set(UI_COOKIE, asLook(form.get('look')), UI_COOKIE_OPTIONS);
  redirect('/projects');
}
