// The handle between the text and the PDF in the new look (T53): dragging, the keyboard, the size
// kept in this browser, where the handle is in the Tab order, no handle in a narrow window, and
// the PDF still drawn after a resize. Only in a run with the new look chosen (E2E_UI=next). Needs
// Docker, the TeX image, the services and the worker (for the PDF).
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { audit, ORIGIN, person, run, signIn } from './helpers';

test.skip(process.env.E2E_UI !== 'next', 'the new look is chosen with E2E_UI=next');

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Results}',
  'Latency stays below forty milliseconds.',
  '\\end{document}',
  '',
].join('\n');

const text = (page: Page) => page.getByRole('region', { name: 'Editor for main.tex' });
const build = (page: Page) => page.locator('.build');
const handle = (page: Page) =>
  page.getByRole('separator', { name: 'Resize the editor and the PDF' });
const widths = async (page: Page) => ({
  text: (await text(page).boundingBox())!.width,
  pdf: (await build(page).boundingBox())!.width,
});

async function open(browser: Parameters<typeof person>[0], who: string) {
  const { page, email } = await person(browser, who);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/sign-in');
  await signIn(page, email);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Resize ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(text(page)).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-ui', 'next');
  await expect(handle(page)).toBeVisible();
  await expect(build(page).getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });
  return page;
}

/** The PDF's first page is drawn: it has a picture. */
async function drawn(page: Page) {
  const first = build(page).locator('.pdf-page[data-page="1"]');
  await expect(first).toHaveAttribute('data-drawn', 'yes', { timeout: 30_000 });
  await expect
    .poll(() => first.locator('canvas').evaluate((c) => (c as HTMLCanvasElement).width))
    .toBeGreaterThan(0);
}

async function drag(page: Page, by: number) {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by / 2, y, { steps: 5 });
  await page.mouse.move(x + by, y, { steps: 5 });
  await page.mouse.up();
}

test('dragging the handle sizes the panes, and the size is kept after a reload', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await open(browser, 'resize-drag');
  await drawn(page);
  const before = await widths(page);
  await drag(page, -150);
  await expect.poll(async () => (await widths(page)).pdf).toBeGreaterThan(before.pdf + 100);
  const after = await widths(page);
  expect(after.text).toBeLessThan(before.text - 100);
  await drawn(page);

  await page.reload();
  await expect(handle(page)).toBeVisible();
  await expect
    .poll(async () => Math.abs((await widths(page)).pdf - after.pdf), { timeout: 10_000 })
    .toBeLessThan(4);
  await drawn(page);
});

test('the panes follow the pointer on release, not while it moves', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await open(browser, 'resize-release');
  const before = await widths(page);
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y, { steps: 8 });
  // Held: the line has moved, the panes have not.
  expect(Math.abs((await widths(page)).pdf - before.pdf)).toBeLessThan(2);
  await page.mouse.up();
  await expect.poll(async () => (await widths(page)).pdf).toBeGreaterThan(before.pdf + 80);
  await drawn(page);
});

test('the arrow keys size the panes', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await open(browser, 'resize-keys');
  const before = await widths(page);
  await handle(page).focus();
  await expect(handle(page)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await widths(page)).text).toBeLessThan(before.text - 10);
  const left = await widths(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await widths(page)).text).toBeGreaterThan(left.text + 10);
  await drawn(page);
});

test('the handle comes after the text in the Tab order, and shows the ring', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await open(browser, 'resize-tab');
  expect(
    await handle(page).evaluate(
      (h) =>
        !!(
          document.querySelector('section[aria-label^="Editor for"]')!.compareDocumentPosition(h) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  ).toBe(true);
  // From the text, Tab reaches the handle, and Shift+Tab from it goes back into the text's pane.
  await page.getByLabel('main.tex, visual editor').click();
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await handle(page).evaluate((h) => h === document.activeElement);
  }
  expect(reached).toBe(true);
  expect(await handle(page).evaluate((h) => getComputedStyle(h).outlineWidth)).toBe('2px');
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest('section[aria-label^="Editor for"]'),
    ),
  ).toBe(true);
});

test('a narrow window has no handle, and the panes are one under another', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await open(browser, 'resize-narrow');
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(handle(page)).toHaveCount(0);
  await expect(page.locator('[data-separator]')).toBeHidden();
  const t = (await text(page).boundingBox())!;
  const p = (await build(page).boundingBox())!;
  expect(t.y).toBeLessThan(p.y);
  expect(Math.abs(t.x - p.x)).toBeLessThan(2);
  expect(t.width).toBeGreaterThan(500);
  expect(p.width).toBeGreaterThan(500);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(handle(page)).toBeVisible();
  // One screen again, wide.
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight),
  ).toBeLessThanOrEqual(1);
});

test('the handle passes the accessibility audit, in light and in dark', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await open(browser, 'resize-axe');
  await drag(page, 60);
  await audit(page, 'the file page with the handle, light');
  await page.getByLabel('main.tex, visual editor').click();
  await handle(page).focus();
  await audit(page, 'the file page with the handle focused, light');
  await page
    .context()
    .addCookies([{ name: 'pw_theme', value: 'dark', domain: new URL(ORIGIN).hostname, path: '/' }]);
  await page.reload();
  await expect(handle(page)).toBeVisible();
  await audit(page, 'the file page with the handle, dark');
});
