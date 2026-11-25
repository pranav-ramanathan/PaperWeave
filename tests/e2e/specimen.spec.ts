// The specimen page of the new look's building blocks (/spike/ui, behind SPIKE like /spike): every
// component in every state. It is read the three ways the real pages must be: audited by axe,
// at 320 CSS pixels wide, and with the text spaced and enlarged. Nothing here needs sign-in.
import { expect, test } from '@playwright/test';
import { audit, refusals, sticksOut } from './helpers';
import { enlarged, lost, spaced } from './look';

test.beforeEach(async ({ page }) => {
  refusals(page.context());
  await page.goto('/spike/ui');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Specimen of the new look' }),
  ).toBeVisible();
});

test('the specimen has no accessibility failures a machine can find', async ({ page }) => {
  await audit(page, 'specimen');
});

test('the specimen is in the new look, with its own faces', async ({ page }) => {
  const main = page.locator('main[data-ui="next"]');
  await expect(main).toHaveCount(1);
  // The faces are named by the page's variables, and the fonts are served from this site.
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    const heading = getComputedStyle(document.querySelector('h1')!).fontFamily;
    const body = getComputedStyle(document.querySelector('main p')!).fontFamily;
    return {
      heading,
      body,
      loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
    };
  });
  expect(faces.heading).toMatch(/literata/i);
  expect(faces.body).toMatch(/atkinson/i);
  // Both were used on the page, so both were fetched.
  expect(faces.loaded.join(' ')).toMatch(/literata/i);
  expect(faces.loaded.join(' ')).toMatch(/atkinson/i);
  // From this site's own static files, not another host (font-src 'self').
  const served = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.endsWith('.woff2') && !n.includes('KaTeX')),
  );
  expect(served.length).toBeGreaterThanOrEqual(2);
  for (const url of served) expect(new URL(url).pathname).toMatch(/^\/_next\/static\/media\//);
});

test('a select is a real select, a tooltip names a button without taking its name', async ({
  page,
}) => {
  const kind = page.getByRole('combobox', { name: 'Select, a real select', exact: true });
  await kind.selectOption('bar');
  await expect(kind).toHaveValue('bar');
  // The tooltip adds words on hover and on focus; the button keeps its own name.
  const bold = page.getByRole('button', { name: 'Bold', exact: true });
  await bold.hover();
  await expect(page.getByRole('tooltip')).toContainText('Ctrl+B');
  await expect(bold).toHaveAccessibleName('Bold');
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Undo', exact: true }).focus();
  await expect(page.getByRole('tooltip')).toContainText('Ctrl+Z');
});

test('the specimen can be read at 320 CSS pixels', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await sticksOut(page)).toEqual([]);
  expect(await lost(page)).toEqual([]);
});

test('the specimen loses nothing when the text is spaced as WCAG 1.4.12 asks', async ({ page }) => {
  await spaced(page);
  expect(await lost(page)).toEqual([]);
});

test('the specimen loses nothing when the text alone is twice as big', async ({ page }) => {
  await enlarged(page);
  expect(await lost(page)).toEqual([]);
});
