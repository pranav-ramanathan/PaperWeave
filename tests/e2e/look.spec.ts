// The switch for the new look (the form at the foot of the papers page): it keeps the person's
// choice in the cookie `pw_ui`, and the papers page (moved to the new look) is drawn in the
// choice, with the same links and buttons in both. Runs as it is in both looks of the suite
// (E2E_UI=next starts each person with the cookie set to "next").
import { expect, test } from '@playwright/test';
import { person, signIn } from './helpers';

const START = process.env.E2E_UI === 'next' ? 'next' : 'classic';
const TRY = 'Try the new look';
const USE_OLD = 'Use the old look';

/** What the person sees of the page, without the switch itself. */
const appearance = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const style = (el: Element | null) => {
      const s = el ? getComputedStyle(el) : null;
      return s && [s.color, s.backgroundColor, s.fontFamily, s.fontSize, s.maxWidth].join('|');
    };
    return {
      ui: document.querySelector('main')?.getAttribute('data-ui') ?? null,
      main: style(document.querySelector('main')),
      h1: style(document.querySelector('h1')),
      body: style(document.body),
      // The links and buttons, in the page's order, but the switch: the same in both looks.
      names: [
        ...document.querySelectorAll(
          'main a[href], main button:not(form[aria-label="Look of the pages"] button, form[aria-label="Theme"] button)',
        ),
      ].map((el) => el.textContent),
    };
  });

test('the switch keeps the choice in a cookie, and the papers page is drawn in it with the same links and buttons', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'look');
  await page.goto('/sign-in');
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();

  const cookie = async () => (await page.context().cookies()).find((c) => c.name === 'pw_ui');
  const switchButton = page.getByRole('button', { name: START === 'next' ? USE_OLD : TRY });
  await expect(switchButton).toBeVisible();
  // Only one of the two is there at a time.
  await expect(page.getByRole('button', { name: START === 'next' ? TRY : USE_OLD })).toHaveCount(0);
  expect((await cookie())?.value).toBe(START === 'next' ? 'next' : undefined);
  const before = await appearance(page);
  // The papers page is in the new look when that is what is chosen, and only then.
  expect(before.ui).toBe(START === 'next' ? 'next' : null);

  // The first, then the other: each sets the cookie and comes back to the papers.
  await switchButton.click();
  const other = START === 'next' ? 'classic' : 'next';
  await expect(page.getByRole('button', { name: START === 'next' ? TRY : USE_OLD })).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  const set = await cookie();
  expect(set).toMatchObject({
    value: other,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
  // About a year, not a session.
  expect(set!.expires - Date.now() / 1000).toBeGreaterThan(300 * 24 * 3600);
  const changed = await appearance(page);
  expect(changed.ui).toBe(other === 'next' ? 'next' : null);
  // Drawn differently, with the same links and buttons in the same order.
  expect(changed.main).not.toEqual(before.main);
  expect(changed.names).toEqual(before.names);

  // It is the choice that stays, across a fresh load, and back again.
  await page.reload();
  await expect(page.getByRole('button', { name: START === 'next' ? TRY : USE_OLD })).toBeVisible();
  expect(await appearance(page)).toEqual(changed);
  await page.getByRole('button', { name: START === 'next' ? TRY : USE_OLD }).click();
  await expect(page.getByRole('button', { name: START === 'next' ? USE_OLD : TRY })).toBeVisible();
  expect((await cookie())?.value).toBe(START);
  expect(await appearance(page)).toEqual(before);
});

test('the switch is the last stop in the page, so nothing before it moved', async ({ browser }) => {
  const { page, email } = await person(browser, 'look-order');
  await page.goto('/sign-in');
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
  const last = await page.evaluate(() => {
    const stops = [
      ...document.querySelectorAll<HTMLElement>(
        'main a[href], main button, main input:not([type=hidden]), main select, main textarea',
      ),
    ];
    return stops.at(-1)?.textContent;
  });
  expect(last).toBe(START === 'next' ? USE_OLD : TRY);
});
