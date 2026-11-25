// Which look a page is drawn in: the one the app has had ("classic") or the new one ("next").
// A page is "next" only when the person has chosen it AND the page has been moved to it. So this
// can be switched on for everyone while pages are moved one at a time, and a page not yet moved
// is the same for a person who has chosen the new look as for one who has not.
//
// The choice is the person's cookie `pw_ui` ("next" or "classic"). With no cookie, the setting
// UI_DEFAULT is the answer (docs/settings.md); with neither, "classic". A page puts the answer on
// its own <main data-ui="...">, not on <html>: the layout is not drawn again when a person moves
// from page to page, and an attribute there would be wrong after the first move.
import { cookies } from 'next/headers';

export type Look = 'classic' | 'next';

/** The cookie that holds a person's choice. */
export const UI_COOKIE = 'pw_ui';

/**
 * The pages that have been moved to the new look, by the name each gives `ui()`. None yet: every
 * page is "classic" whatever has been chosen. A page is added here in the change that moves it.
 */
export const MIGRATED: readonly string[] = [];

/**
 * The pages being built in the new look over several changes, by the name each gives `ui()`. None
 * yet. A page here is "next" only when UI_STAGED=1 on the server and the person's cookie is
 * "next"; for everyone else it is "classic", so a half-moved page is never shown. The last change
 * for a page moves it from here to MIGRATED.
 */
export const STAGED: readonly string[] = ['paper'];

/**
 * What UI_STAGED says: "1" is on, "0" and not set are off. Anything else stops whoever asks, as
 * UI_DEFAULT does.
 */
export function uiStaged(value: string | undefined = process.env.UI_STAGED): boolean {
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error(`UI_STAGED is "${value}": it must be "1" or "0" (or not set)`);
}

/**
 * What UI_DEFAULT says: "classic" or "next", and "classic" when it is not set. Anything else
 * stops whoever asks (the service's first request, and so every one after it) with a message that
 * says what to set it to, rather than quietly showing the old look to everyone.
 */
export function uiDefault(value: string | undefined = process.env.UI_DEFAULT): Look {
  if (value === undefined || value === '') return 'classic';
  if (value === 'classic' || value === 'next') return value;
  throw new Error(`UI_DEFAULT is "${value}": it must be "classic" or "next" (or not set)`);
}

/**
 * The look of a page, given what is known: the cookie's value, the setting's, and the pages that
 * have been moved. Separate from `ui` so that it can be tested without a request.
 */
export function look(
  page: string,
  cookie: string | undefined,
  fallback: Look,
  migrated: readonly string[] = MIGRATED,
  staged: readonly string[] = STAGED,
  stagedOn = false,
): Look {
  // A staged page is unfinished: it is "next" only for a person who asked for it by cookie, on a
  // server that has UI_STAGED=1. UI_DEFAULT does not reach it.
  if (staged.includes(page)) return stagedOn && cookie === 'next' ? 'next' : 'classic';
  if (!migrated.includes(page)) return 'classic';
  // A cookie that is neither is not a choice: it is as if there were none.
  return cookie === 'next' || cookie === 'classic' ? cookie : fallback;
}

/**
 * What the person has chosen, whether or not any page has been moved yet: the cookie when it is a
 * choice, else the setting. This is what the switch on the papers page shows; `look` is what a
 * page is drawn in.
 */
export function chosen(cookie: string | undefined, fallback: Look): Look {
  return cookie === 'next' || cookie === 'classic' ? cookie : fallback;
}

/** The choice of the person asking (see `chosen`). */
export async function chosenLook(): Promise<Look> {
  return chosen((await cookies()).get(UI_COOKIE)?.value, uiDefault());
}

/**
 * The value the switch's form sends: "next" or "classic" and nothing else, so that a forged post
 * cannot put anything else in the cookie.
 */
export function asLook(value: unknown): Look {
  if (value === 'next' || value === 'classic') return value;
  throw new Error('The look must be "next" or "classic"');
}

/**
 * How the choice is kept. A year, for the whole site, and not sent with a request from another
 * site (Lax). Only the server reads it, so scripts need not (httpOnly). It is a preference, not a
 * credential, so it is not Secure-only: it must also work on the plain-http address the tests
 * and local work use.
 */
export const UI_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 365,
} as const;

/** The look of a page for the person asking. `page` is the name the page is listed under. */
export async function ui(page: string): Promise<Look> {
  // The setting is read even for a page that is not moved, so that a wrong one is found at once.
  const fallback = uiDefault();
  const stagedOn = uiStaged();
  return look(page, (await cookies()).get(UI_COOKIE)?.value, fallback, MIGRATED, STAGED, stagedOn);
}
