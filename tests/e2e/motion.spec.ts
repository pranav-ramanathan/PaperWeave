// Motion in the new look (apps/web/app/next/motion.css): a dialog and a menu fade in, and under
// prefers-reduced-motion nothing animates at all. Uses the overlays specimen (behind SPIKE); no
// sign-in. Only meaningful in the new look, where the specimen is the new look's.
import { expect, test, type Page } from '@playwright/test';

const running = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .map((a) => (a as CSSAnimation).animationName)
      .filter((n) => n && n.startsWith('pw-')),
  );

async function open(page: Page) {
  await page.goto('/spike/ui/overlays');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Specimen of dialogs and menus' }),
  ).toBeVisible();
}

test('with motion, the dialog fades in and takes focus at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page);
  await page.getByRole('button', { name: 'Insert a caption', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Caption', exact: true })).toBeFocused();
  expect(await running(page)).toContain('pw-pop');
});

test('with reduced motion, no animation runs and the dialog is whole at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.getByRole('button', { name: 'Insert a caption', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Insert a caption' })).toBeVisible();
  expect(await running(page)).toEqual([]);
  const style = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('[data-slot="dialog-content"]')!);
    return { opacity: s.opacity, animationName: s.animationName };
  });
  expect(style).toEqual({ opacity: '1', animationName: 'none' });
});
