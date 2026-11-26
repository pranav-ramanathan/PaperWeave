// The new look's app parts (app bar, mark, notice, tooltip, the kit context) on their specimen
// page, /spike/ui/parts, which is there only where SPIKE is on. Needs no sign-in.
import { expect, test } from '@playwright/test';
import { audit, refusals, sticksOut } from './helpers';

test('the parts pass the accessibility audit, in both themes, and no content-policy refusal', async ({
  page,
}) => {
  refusals(page.context());
  await page.goto('/spike/ui/parts');
  await expect(page.locator('main')).toHaveAttribute('data-ui', 'next');
  await expect(page.getByRole('heading', { name: 'App parts' })).toBeVisible();
  await audit(page, 'app parts, light');
  await page.goto('/spike/ui/parts?theme=dark');
  await expect(page.locator('main')).toHaveAttribute('data-theme', 'dark');
  await audit(page, 'app parts, dark');
});

test('there is no sideways scroll at 320 px', async ({ page }) => {
  refusals(page.context());
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/spike/ui/parts');
  await expect(page.getByRole('heading', { name: 'App parts' })).toBeVisible();
  expect(await sticksOut(page)).toEqual([]);
});

test('the app bar is first in the page, names where you are, and the mark is only decoration', async ({
  page,
}) => {
  refusals(page.context());
  await page.goto('/spike/ui/parts');
  const bar = page.locator('main > header');
  await expect(bar.getByRole('link', { name: 'PaperWeave' })).toBeVisible();
  const crumbs = bar.getByRole('navigation', { name: 'Where you are' });
  await expect(crumbs.getByRole('link', { name: 'Specimens' })).toBeVisible();
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('App parts');
  // Inline, hidden from screen readers, and nothing was fetched for it.
  await expect(bar.locator('svg[aria-hidden="true"]').first()).toBeVisible();
  // The first stop in Tab order is the bar's own home link: nothing is before the page's content.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'PaperWeave' })).toBeFocused();
});

test('a notice keeps the live-region roles the app uses', async ({ page }) => {
  refusals(page.context());
  await page.goto('/spike/ui/parts');
  await expect(
    page.getByRole('status').filter({ hasText: 'The PDF is up to date.' }),
  ).toBeVisible();
  // (The framework's own route announcer is an alert too, outside <main>.)
  await expect(page.locator('main').getByRole('alert')).toHaveText('The title cannot be empty.');
  // A polite region is there for the editor's kind of notice, with its actions in a named group.
  await expect(page.locator('main [aria-live="polite"]')).toContainText('You restored a copy');
  const group = page.getByRole('group', { name: 'About the restore' });
  await expect(group.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  // The prefix comes from functional.css, once, before the words of an alert.
  const prefix = await page
    .locator('main')
    .getByRole('alert')
    .evaluate((el) => getComputedStyle(el, '::before').content);
  expect(prefix).toBe('"Problem: "');
});

test('a tooltip shows on hover and on keyboard focus, is no tab stop and not the name', async ({
  page,
}) => {
  refusals(page.context());
  await page.goto('/spike/ui/parts');
  const button = page.getByRole('button', { name: 'Add a comment' });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await button.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Add a comment');
  // Away in steps: a single jump leaves the popup's grace area (for moving onto it) open.
  await page.mouse.move(0, 400, { steps: 8 });
  await page.mouse.move(2, 402);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  // The name is the button's own, and the tooltip did not add a stop: from this button one Tab
  // reaches the next button, and the tooltip opens on focus.
  await button.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Add a comment');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Ask for a model review' })).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('Ask for a model review');
  // The tooltip is inside <main>, so that the new look's rules reach it.
  await expect(page.locator('main [data-slot="tooltip-content"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('the kit context says kit on this page', async ({ page }) => {
  refusals(page.context());
  await page.goto('/spike/ui/parts');
  await expect(page.getByTestId('kit')).toHaveText('kit');
});
