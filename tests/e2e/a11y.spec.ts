// An automated accessibility audit of the pages people spend their time on. It finds what a
// machine can find (names, roles, contrast, structure); it does not replace trying the pages
// with a keyboard and a screen reader. Needs the services, the sync server and the worker.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { person, run, selectWord, showSource, signIn } from './helpers';

const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\begin{document}',
  '\\section{Results}',
  'Latency stays below forty milliseconds, see Equation~\\ref{eq:mean} and \\cite{knuth1984}.',
  '\\begin{equation}',
  '  \\label{eq:mean}',
  '  \\bar{x} = 1',
  '\\end{equation}',
  '\\begin{table}[t]',
  '  \\caption{What was measured.}',
  '  \\begin{tabular}{ll}',
  '    A & B \\\\',
  '    1 & 2 \\\\',
  '  \\end{tabular}',
  '\\end{table}',
  'The sentense has a mistake.',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');
const BIB = '@book{knuth1984, author = {Donald Knuth}, title = {The TeXbook}, year = 1984}\n';
const CSV = 'day,latency (ms)\n2024-03-01,9\n2024-03-02,38\n';

/** Everything axe can check against WCAG 2.1 A and AA on the page as it stands. */
async function audit(page: Page, what: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    violations.map(
      (v) => `${what}: ${v.id} (${v.help}) at ${v.nodes.map((n) => n.target).join('; ')}`,
    ),
  ).toEqual([]);
}

test('the main pages have no accessibility failures a machine can find', async ({ browser }) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'a11y-owner');
  await page.goto('/sign-in');
  await audit(page, 'sign-in');
  await signIn(page, email);
  await audit(page, 'papers');

  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Audit ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'refs.bib', bytes: Buffer.from(BIB) },
      { path: 'data/latency.csv', bytes: Buffer.from(CSV) },
    ]),
  );
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  const paper = page.url();
  await audit(page, 'paper');

  await page.getByRole('link', { name: 'Describe it' }).click();
  await expect(page.getByRole('button', { name: 'Approve this description' })).toBeVisible();
  await audit(page, 'data file');
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await page.getByRole('link', { name: /New chart from/ }).click();
  await expect(page.getByRole('heading', { name: 'New chart' })).toBeVisible();
  await audit(page, 'new chart');

  await page.goto(`${paper}/submit`);
  await expect(page.getByRole('heading', { name: /before submitting/ })).toBeVisible();
  await audit(page, 'checks before submitting');

  // The editor, with everything it can show at once: a finding, a thread, a proposal, the PDF.
  await page.goto(paper);
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });
  await expect(
    page.getByRole('region', { name: 'Spelling and grammar' }).getByRole('article').first(),
  ).toBeVisible({ timeout: 30_000 });
  await selectWord(page, '.editor .visual .ProseMirror', 'forty');
  await page.getByRole('button', { name: 'Comment on the selected text' }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Which percentile?');
  await page.getByRole('button', { name: 'Start thread' }).click();
  await expect(page.getByRole('article', { name: 'Thread on “forty”' })).toBeVisible();
  await selectWord(page, '.editor .visual .ProseMirror', 'milliseconds');
  await page.getByRole('button', { name: 'Propose a change here' }).click();
  await page.getByLabel('Replace it with').fill('ms');
  await page.getByRole('button', { name: 'Propose', exact: true }).click();
  await expect(page.getByRole('article', { name: /Proposal to change/ })).toBeVisible();
  await audit(page, 'editor, visual view');
  await showSource(page);
  await audit(page, 'editor, source view');
});

test('a thread is started and a line is shown in the PDF with the keyboard alone', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'a11y-keys');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Keys ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'refs.bib', bytes: Buffer.from(BIB) },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });

  /** Press Tab (or Shift+Tab) until the thing with this name has the keyboard. */
  const tabTo = async (name: string | RegExp, key = 'Tab') => {
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press(key);
      const now = await page.evaluate(() => {
        const el = document.activeElement as (HTMLElement & { labels?: NodeList }) | null;
        // What it is called: its own name, or its label, or what it says.
        const label = el?.labels?.[0]?.firstChild?.textContent;
        return (el?.getAttribute('aria-label') ?? label ?? el?.textContent ?? '').trim();
      });
      if (typeof name === 'string' ? now === name : name.test(now)) return;
    }
    throw new Error(`Tab never reached ${name}`);
  };

  // Into the text, and five characters selected, without the pointer. (The first click only
  // gives the page the keyboard, as opening it in a tab would.)
  await page.locator('h1').click();
  await tabTo(/visual editor$/);
  // The caret is in the text, though the file begins with a preamble that is not text.
  await expect
    .poll(() =>
      page.evaluate(() => !!getSelection()?.anchorNode?.parentElement?.closest('.ProseMirror')),
    )
    .toBe(true);
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowRight');
  const picked = await page.evaluate(() => getSelection()!.toString());
  expect(picked.length).toBeGreaterThan(3);

  // Leaving the text keeps what was selected: on to the comments, and a thread on it.
  await tabTo('Comment on the selected text');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Comments' }).locator('blockquote')).toHaveText(
    picked,
  );
  await tabTo('Comment');
  await page.keyboard.type('Started without a mouse.');
  await tabTo('Start thread');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: /^Thread on/ })).toContainText(
    'Started without a mouse.',
  );

  // Back up to the toolbar: the caret's line is shown in the PDF, and the page says so.
  await tabTo('Show in PDF', 'Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('.build .pdf-said')).toHaveText('Shown on page 1 of the PDF.');
  // The PDF itself can be reached and scrolled from the keyboard.
  await tabTo('Pages of the PDF');
  await expect(page.getByRole('region', { name: 'Pages of the PDF' })).toBeFocused();
});
