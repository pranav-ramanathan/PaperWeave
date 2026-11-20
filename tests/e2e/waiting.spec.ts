// What the page says while the server is slow to answer a form or a link.
// Needs the services in infra/compose.yaml.
import { expect, test } from '@playwright/test';
import { person, run, signIn } from './helpers';

async function newPaper(browser: Parameters<typeof person>[0], name: string) {
  const owner = await person(browser, 'waiter');
  await owner.page.goto('/projects');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Name of a new paper').fill(name);
  await owner.page.getByRole('button', { name: 'Create paper' }).click();
  await expect(owner.page.getByRole('heading', { name })).toBeVisible();
  return owner.page;
}

test('a form slow to be answered says it is working, then that it is still waiting', async ({
  browser,
}) => {
  const page = await newPaper(browser, `Slow form ${run}`);
  const waiting = page.locator('#waiting');
  await expect(waiting).toHaveText('');

  // The server takes 9.5 seconds to answer the action.
  await page.route(/\/projects\/[0-9a-f-]+/, async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.headers()['next-action']) {
      await new Promise((r) => setTimeout(r, 9_500));
    }
    await route.fallback();
  });
  await page.getByLabel('Name for the paper as it is now').fill('Slow');
  const save = page.getByRole('button', { name: 'Save revision' });
  await save.click();
  await expect(waiting).toHaveText('Working…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(waiting).toContainText('No answer from the server yet', { timeout: 12_000 });

  await expect(page.getByRole('status')).toContainText('Saved as revision 1', { timeout: 15_000 });
  await expect(waiting).toHaveText('');
  await expect(page.getByRole('rowheader', { name: /^1\./ })).toHaveCount(1);
});

test('a page slow to come says so', async ({ browser }) => {
  const name = `Slow page ${run}`;
  const page = await newPaper(browser, name);
  await page.goto('/projects');
  const waiting = page.locator('#waiting');
  await page.route(/\/projects\/[0-9a-f-]+(\?|$)/, async (route) => {
    if (route.request().headers()['rsc']) await new Promise((r) => setTimeout(r, 2_500));
    await route.fallback();
  });
  await page.getByRole('link', { name }).click();
  await expect(waiting).toHaveText('Working…');
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(waiting).toHaveText('');
});
