// The overlay primitives of the new look (components/ui/dialog.tsx, dropdown-menu.tsx) on their
// specimen page, /spike/ui/overlays (behind SPIKE). What the plan (PLAN.md section 7) asks of a
// Radix dialog is held here: it mounts inside <main>, focus goes to a named field and typing
// straight after opening lands in it, Escape closes and gives focus back, the page's content
// policy has nothing to refuse (the scroll lock's <style> carries the page's number), axe passes
// with it open, and it does not stick out at 320 px. Nothing here needs sign-in.
import { expect, test } from '@playwright/test';
import { audit, refusals, sticksOut } from './helpers';
import { lost } from './look';

test.beforeEach(async ({ page }) => {
  refusals(page.context());
  await page.goto('/spike/ui/overlays');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Specimen of dialogs and menus' }),
  ).toBeVisible();
});

const opener = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Insert a caption', exact: true });
const dialog = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog', { name: 'Insert a caption' });
const field = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', { name: 'Caption', exact: true });

test('the dialog opens by mouse, in the new look and inside main, with focus in its field', async ({
  page,
}) => {
  await opener(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  // Inside <main data-ui="next"> (so inside a landmark and under the tokens), not in <body>.
  await expect(page.locator('main[data-ui="next"] [role="dialog"]')).toHaveCount(1);
  // No blur behind it, and the overlay's colour comes from the tokens.
  const look = await page.evaluate(() => {
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    const s = getComputedStyle(overlay);
    return { blur: s.backdropFilter, colour: s.backgroundColor, inMain: !!overlay.closest('main') };
  });
  expect(look.blur).toBe('none');
  expect(look.colour).not.toBe('rgba(0, 0, 0, 0)');
  expect(look.inMain).toBe(true);
});

test('typing straight after the click lands in the field', async ({ page }) => {
  await opener(page).click();
  // No waiting for the dialog or the focus: the keys follow the click as fast as a person's.
  await page.keyboard.type('Typed ahead');
  await expect(field(page)).toHaveValue('Typed ahead');
});

test('typing straight after opening by keyboard lands in the field', async ({ page }) => {
  await opener(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Keys first');
  await expect(field(page)).toHaveValue('Keys first');
});

test('Escape closes the dialog and focus goes back to what opened it', async ({ page }) => {
  await opener(page).focus();
  await page.keyboard.press('Enter');
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(opener(page)).toBeFocused();
});

test('Enter in the field inserts and closes', async ({ page }) => {
  await opener(page).click();
  await page.keyboard.type('A caption');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Caption: A caption');
  await expect(opener(page)).toBeFocused();
});

test('a dialog that is open has no accessibility failures a machine can find', async ({ page }) => {
  await opener(page).click();
  await expect(field(page)).toBeFocused();
  await audit(page, 'dialog open');
});

test('the dialog does not stick out at 320 CSS pixels', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await opener(page).click();
  await expect(field(page)).toBeFocused();
  expect(await sticksOut(page)).toEqual([]);
  expect(await lost(page)).toEqual([]);
  const box = await dialog(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
});

test('the menu opens by keyboard, arrows move, Escape closes and gives focus back', async ({
  page,
}) => {
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(page.locator('main[data-ui="next"] [role="menu"]')).toHaveCount(1);
  // Radix puts focus on the first item; arrows move it; typeahead jumps.
  await expect(page.getByRole('menuitem', { name: /^Equation/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Figure' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: /^Equation/ })).toBeFocused();
  await page.keyboard.type('t');
  await expect(page.getByRole('menuitem', { name: 'Table' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
});

test('a menu item is chosen with Enter, and the checkbox item toggles', async ({ page }) => {
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.click();
  await page.getByRole('menuitem', { name: 'Figure' }).click();
  await expect(page.getByRole('status')).toContainText('Chose: Figure');
  await more.click();
  const keep = page.getByRole('menuitemcheckbox', { name: 'Keep spacing' });
  await expect(keep).toHaveAttribute('aria-checked', 'true');
  await keep.click();
  await expect(page.getByRole('status')).toContainText('Spacing is not kept.');
});

test('a menu that is open has no accessibility failures a machine can find', async ({ page }) => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await audit(page, 'menu open');
});
