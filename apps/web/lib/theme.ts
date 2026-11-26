// The colours a page is drawn in: light, dark, or (no choice) the device's own.
//
// The choice is the person's cookie `pw_theme` ("light" or "dark"). Without it, the page follows
// the device (`prefers-color-scheme`, in next.css). The layout puts the choice on <html> as
// data-theme, on the server, so that the first paint is already in it: nothing is decided by a
// script after the page has been drawn, and nothing flashes. With no choice there is no
// attribute at all.
import { cookies } from 'next/headers';

export type Theme = 'light' | 'dark';

/** The cookie that holds a person's choice. */
export const THEME_COOKIE = 'pw_theme';

/** What the person has chosen: "light", "dark", or null when the cookie is absent or is neither. */
export function chosenTheme(cookie: string | undefined): Theme | null {
  return cookie === 'light' || cookie === 'dark' ? cookie : null;
}

/**
 * What a press of the control does: from the device's own to light, from light to dark, from dark
 * back to the device's own (null: the cookie is taken off).
 */
export function nextTheme(now: Theme | null): Theme | null {
  return now === null ? 'light' : now === 'light' ? 'dark' : null;
}

/** The value the control's form sends: "light", "dark" or "system", and nothing else. */
export function asTheme(value: unknown): Theme | null {
  if (value === 'light' || value === 'dark') return value;
  if (value === 'system') return null;
  throw new Error('The theme must be "light", "dark" or "system"');
}

/** How the choice is kept: a year, for the whole site. */
export const THEME_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 365,
} as const;

/** The choice of the person asking. */
export async function theme(): Promise<Theme | null> {
  return chosenTheme((await cookies()).get(THEME_COOKIE)?.value);
}
