'use server';

import { cookies } from 'next/headers';
import { asTheme, THEME_COOKIE, THEME_COOKIE_OPTIONS } from '../lib/theme';

/**
 * The control in the app bar (components/theme-switch.tsx): keeps the person's choice of colours
 * in the cookie `pw_theme`, or takes it off ("system": follow the device). The page it was pressed
 * on is drawn again by the framework, since a cookie has changed; no one is sent anywhere. No one
 * need be signed in: it is a preference of this browser, as the page's look is.
 */
export async function themeAction(form: FormData) {
  const choice = asTheme(form.get('theme'));
  const jar = await cookies();
  if (choice) jar.set(THEME_COOKIE, choice, THEME_COOKIE_OPTIONS);
  else jar.delete(THEME_COOKIE);
}
