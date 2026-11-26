// The old look and its switch were removed (T52). A browser that still carries the cookie `pw_ui`
// that the switch set (`classic` or `next`, or anything else) is not told apart from one without
// it: the same page, drawn the same way, with no switch anywhere.
import { expect, type Page, test } from '@playwright/test';
import { person, signIn } from './helpers';

/** What the person sees of the papers page: how it is drawn, and its links and buttons in order. */
const appearance = (page: Page) =>
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
      names: [
        ...document.querySelectorAll(
          'main a[href], main button, main input:not([type=hidden]), main select, main textarea',
        ),
      ].map((el) => el.textContent || el.getAttribute('name')),
    };
  });

test('an old pw_ui cookie is ignored: the papers page is the same, with no switch', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'look');
  await page.goto('/sign-in');
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
  const url = page.url();
  const bare = await appearance(page);
  expect(bare.ui).toBe('next');
  // The page has no switch for the look, and no form for one.
  const gone = async () => {
    await expect(page.getByRole('button', { name: /new look|old look/i })).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Look of the pages' })).toHaveCount(0);
    await expect(page.locator('input[name="look"]')).toHaveCount(0);
  };
  await gone();

  for (const value of ['classic', 'next', 'something-else']) {
    await page.context().addCookies([{ name: 'pw_ui', value, url }]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
    expect(await appearance(page), `pw_ui=${value}`).toEqual(bare);
    await gone();
    // Nothing answers to it either: the cookie is not kept, changed or removed by the server.
    expect(
      (await page.context().cookies()).find((c) => c.name === 'pw_ui')?.value,
      `pw_ui=${value} is as it was set`,
    ).toBe(value);
  }
});

test('with the cookie pw_ui=classic from before, the sign-in page is the new look', async ({
  browser,
}) => {
  const { page } = await person(browser, 'look-signin');
  await page.goto('/sign-in');
  await page.context().addCookies([{ name: 'pw_ui', value: 'classic', url: page.url() }]);
  await page.reload();
  await expect(page.locator('main')).toHaveAttribute('data-ui', 'next');
  await expect(page.getByRole('heading', { name: 'Sign in to PaperWeave' })).toBeVisible();
});
