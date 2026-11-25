// The build pane goes on asking how the builds stand after one answer of "not found".
import { expect, test } from '@playwright/test';
import { clickAfter, person, run, signIn } from './helpers';

test('one "not found" while a build waits does not leave the pane at "Compiling…"', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'stale404');
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Name of a new paper').fill(`Stale ${run}`);
  await page.getByLabel('Start from').selectOption({ label: 'Article' });
  await page.getByRole('button', { name: 'Create paper' }).click();
  await page.getByRole('link', { name: 'main.tex', exact: true }).first().click();
  const status = page.locator('.build').getByRole('status');
  await expect(status).toHaveText('The PDF is up to date.', { timeout: 60_000 });

  // The pane is told once that a build is waiting; the answer after that one is "not found",
  // once. Every other answer is the server's own.
  let waiting = false;
  let refused = 0;
  await page.route(/\/projects\/[^/]+\/builds$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (waiting && !refused) {
      refused++;
      return route.fulfill({ status: 404, json: { error: 'Not found.' } });
    }
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (body?.latest?.status === 'queued') waiting = true;
    return route.fulfill({ response: res });
  });
  await clickAfter(page, '.editor .visual .ProseMirror', 'what does not.');
  await page.keyboard.type(' Tested.');
  await expect.poll(() => refused, { timeout: 30_000 }).toBe(1);

  await expect(status).toHaveText('The PDF is up to date.', { timeout: 30_000 });
});
