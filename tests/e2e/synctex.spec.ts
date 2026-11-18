// Between the text and the PDF: a line is shown in the PDF, and a place in the PDF leads to its
// line, in this file or another. Needs Docker, the TeX image, the services and the worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { caretLine, clickAfter, person, run, showSource, signIn } from './helpers';

// Two pages: the second section starts the second page, and is in a file of its own.
const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{First}',
  'The opening paragraph of the paper.',
  '',
  'A second paragraph, further down the first page.',
  '\\newpage',
  '\\input{second}',
  '\\end{document}',
  '',
].join('\n');
const SECOND = [
  '\\section{Second}',
  'Text on the second page.',
  '',
  'Its last paragraph.',
  '',
].join('\n');
const build = (page: Page) => page.locator('.build');

test('a line is shown in the PDF, and a place in the PDF leads back to its line', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'synctex-owner');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `SyncTeX ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'second.tex', bytes: Buffer.from(SECOND) },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'second.tex' }).first().click();
  await expect(page.getByRole('region', { name: 'Editor for second.tex' })).toBeVisible();
  await expect(build(page).getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });
  await expect(build(page).getByRole('group', { name: 'Page 2 of 2' })).toBeAttached();
  // The pages are not only pictures: their words are there to be read and selected.
  await expect(build(page).getByRole('group', { name: 'Page 1 of 2' })).toContainText(
    'The opening paragraph of the paper.',
  );

  // From the visual view: the caret's line is on the second page, and the pane goes there.
  await clickAfter(page, '.editor .visual .ProseMirror', 'last paragraph');
  await page
    .getByRole('group', { name: 'Go to' })
    .getByRole('button', { name: 'Show in PDF' })
    .click();
  await expect(build(page).locator('.pdf-said')).toHaveText('Shown on page 2 of the PDF.');
  const mark = build(page).locator('.pdf-mark');
  await expect(mark).toHaveAttribute('data-page', '2');
  await expect(mark).toBeInViewport();

  // From the PDF: a double-click on the first page's second paragraph leads to main.tex, line 6.
  // Find the paragraph the way a reader would: ask where line 6 is, then click there.
  const at = await page.evaluate(async () => {
    const link = document.querySelector<HTMLAnchorElement>('.build a[href$="/pdf"]')!;
    const files = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label=Files] a')];
    const main = files
      .find((a) => a.textContent === 'main.tex')!
      .href.split('/')
      .pop();
    const res = await fetch(`${link.href.replace(/pdf$/, 'sync')}?file=${main}&line=6`);
    return res.json() as Promise<{ page: number; x: number; y: number; height: number }>;
  });
  expect(at.page).toBe(1);
  /** Double-click that paragraph on the first page, wherever the page now is on the screen. */
  const pickIt = async () => {
    const shown = build(page).getByRole('group', { name: 'Page 1 of 2' });
    await build(page)
      .locator('.pdf')
      .evaluate((el) => {
        el.scrollTo(0, 0);
        el.scrollIntoView({ block: 'start' });
      });
    await expect(shown).toHaveAttribute('data-drawn', 'yes');
    const box = (await shown.boundingBox())!;
    const size = await shown.evaluate((el: HTMLElement) => ({
      w: Number(el.dataset.width),
      h: Number(el.dataset.height),
    }));
    await page.mouse.dblclick(
      box.x + ((at.x + 30) / size.w) * box.width,
      box.y + ((at.y + at.height * 0.7) / size.h) * box.height,
    );
  };
  await pickIt();
  // The other file opens, with the caret on that line.
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  await expect(page).toHaveURL(/line=6$/);
  await showSource(page);
  await expect.poll(() => caretLine(page)).toBe(6);

  // And within one file, in the source view: line 4 is on page 1.
  await clickAfter(page, '.editor .cm-content', 'opening paragraph');
  await expect.poll(() => caretLine(page)).toBe(4);
  await page.getByRole('button', { name: 'Show in PDF' }).click();
  await expect(build(page).locator('.pdf-said')).toHaveText('Shown on page 1 of the PDF.', {
    timeout: 60_000,
  });
  await expect(build(page).locator('.pdf-mark')).toHaveAttribute('data-page', '1');
  // From the PDF again, now that the line is in the file that is open: the caret goes to it,
  // and the pane says where that was.
  await pickIt();
  await expect(build(page).locator('.pdf-said')).toHaveText('That is line 6 of main.tex.');
  await expect.poll(() => caretLine(page)).toBe(6);
});
