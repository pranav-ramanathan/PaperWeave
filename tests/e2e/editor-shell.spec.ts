// The editor's workspace shell in the new look (T18): the app bar, the three-pane grid and the
// file tree. The editor is a STAGED page (apps/web/lib/ui.ts): it is in the new look only on a
// server with UI_STAGED=1, for a person whose cookie is `pw_ui=next`. This spec sets that cookie
// itself, so it needs only UI_STAGED=1; without it the editor is always the old look and these
// tests have nothing to look at. (The editor-heavy specs run as they are in both looks.)
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { audit, ORIGIN, person, run, signIn, sticksOut } from './helpers';
import { enlarged, lost, spaced } from './look';

test.skip(process.env.UI_STAGED !== '1', 'the editor is in the new look only with UI_STAGED=1');

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Results}',
  'Latency stays below forty milliseconds.',
  '\\input{sections/intro}',
  '\\end{document}',
  '',
].join('\n');

const files = (page: Page) => page.getByRole('navigation', { name: 'Files' });

/** A paper with a folder, opened in its root file, with the new look chosen. */
async function open(browser: Parameters<typeof person>[0], who: string) {
  const { page, email } = await person(browser, who);
  await page
    .context()
    .addCookies([{ name: 'pw_ui', value: 'next', domain: new URL(ORIGIN).hostname, path: '/' }]);
  await page.goto('/sign-in');
  await signIn(page, email);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Shell ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'sections/intro.tex', bytes: Buffer.from('Introduction.\n') },
      { path: 'refs.bib', bytes: Buffer.from('@book{k, title = {T}, year = 1984}\n') },
    ]),
  );
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator('main')).toHaveAttribute('data-ui', 'next');
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  return { page, name: `Shell ${run}` };
}

test('the shell passes the accessibility audit, with the app bar, the tree and the three panes', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, name } = await open(browser, 'shell-audit');

  // The same names, roles and order as the old look.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await expect(page.getByRole('link', { name: 'Paper overview' })).toBeVisible();
  const links = files(page).getByRole('link');
  await expect(links).toHaveText(['main.tex', 'refs.bib', 'sections/intro.tex']);

  // The app bar names where the person is: the paper, then the file.
  const bar = page.locator('main > header');
  await expect(bar.getByRole('navigation', { name: 'Where you are' })).toContainText(name);
  await expect(bar.getByRole('navigation', { name: 'Where you are' })).toContainText('main.tex');

  // The tree: the open file is marked for everyone (aria-current) and to the eye, the folder is
  // a row of its own, and the root file says so beside its name, not inside the link's name.
  await expect(files(page).getByRole('link', { name: 'main.tex' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(files(page).locator('[aria-current="page"]')).toHaveCount(1);
  await expect(files(page).getByText('root', { exact: true })).toBeVisible();
  await expect(files(page).getByText('sections', { exact: true })).toBeVisible();
  const marked = async (path: string) =>
    files(page)
      .getByRole('link', { name: path })
      .evaluate((a) => getComputedStyle(a).backgroundColor);
  expect(await marked('main.tex')).not.toBe(await marked('refs.bib'));

  await audit(page, 'editor shell, new look');
});

test('the three panes sit side by side in one screen, and flow when the window is narrow', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page } = await open(browser, 'shell-grid');
  const boxes = async () => ({
    tree: (await files(page).boundingBox())!,
    text: (await page.getByRole('region', { name: 'Editor for main.tex' }).boundingBox())!,
    pdf: (await page.locator('.build').boundingBox())!,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await boxes();
  expect(wide.tree.x).toBeLessThan(wide.text.x);
  expect(wide.text.x).toBeLessThan(wide.pdf.x);
  expect(Math.abs(wide.tree.y - wide.pdf.y)).toBeLessThan(2);
  // One screen: the page itself does not scroll, each pane does.
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight),
  ).toBeLessThanOrEqual(1);

  // Narrow: one under another, in the page's order, and the page scrolls.
  await page.setViewportSize({ width: 800, height: 900 });
  const narrow = await boxes();
  expect(narrow.tree.y).toBeLessThan(narrow.text.y);
  expect(narrow.text.y).toBeLessThan(narrow.pdf.y);

  // Wide but short (200 % zoom is about this): the page flows.
  await page.setViewportSize({ width: 1280, height: 500 });
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight),
  ).toBeGreaterThan(1);
});

test('there is no sideways scroll at 320 px, and nothing is lost when the text is spaced or doubled', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page } = await open(browser, 'shell-narrow');
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await sticksOut(page)).toEqual([]);

  // The shell's own parts, under the text-spacing rules and at twice the size.
  await page.setViewportSize({ width: 1280, height: 720 });
  const mine = (found: string[]) =>
    found.filter((s) => /header|nav|files|workspace/.test(s) && !/editor-bar|toolbar/.test(s));
  await spaced(page);
  expect(mine(await lost(page))).toEqual([]);
  await enlarged(page);
  expect(mine(await lost(page))).toEqual([]);
});

test('Tab goes from the skip link to the text, with the bar between and the tree after', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page } = await open(browser, 'shell-keys');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to the text' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#text')).toBeFocused();
});
