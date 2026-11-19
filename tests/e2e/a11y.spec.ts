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
  // An address that leads nowhere, which is also what a paper that is not yours looks like.
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
  await audit(page, 'nothing here');
  await page.getByRole('link', { name: 'All papers' }).click();
  await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();

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

/**
 * What sticks out past the right edge of a narrow window, so that the page has to be scrolled
 * sideways to read it. Things that scroll sideways within themselves are allowed to: a wide
 * table, a line of source, a page of the PDF.
 */
const sticksOut = (page: Page) =>
  page.evaluate(() => {
    const wide = document.documentElement.scrollWidth - window.innerWidth;
    if (wide <= 1) return [];
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
      }
      return false;
    };
    const out: string[] = [`the page is ${wide}px wider than the window`];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= window.innerWidth + 1 || inScroller(el)) continue;
      // The outermost culprits only.
      if ([...out].some((o) => o.includes(`<${el.parentElement?.tagName.toLowerCase()}`))) continue;
      out.push(
        `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}> reaches ${Math.round(r.right)}px: "${(el.textContent ?? '').trim().slice(0, 40)}"`,
      );
      if (out.length > 6) break;
    }
    return out;
  });

test('the main pages can be read in a narrow window without scrolling sideways', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // 320 CSS pixels wide: what a 1280-pixel window becomes at 400% zoom.
  const { page, email } = await person(browser, 'a11y-narrow');
  await page.setViewportSize({ width: 320, height: 800 });
  const found: string[] = [];
  const look = async (what: string) =>
    void found.push(...(await sticksOut(page)).map((s) => `${what}: ${s}`));

  await page.goto('/sign-in');
  await look('sign-in');
  await signIn(page, email);
  await look('papers');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Narrow ${run}.zip`);
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
  await look('paper');
  await page.getByRole('link', { name: 'Describe it' }).click();
  await expect(page.getByRole('button', { name: 'Approve this description' })).toBeVisible();
  await look('data file');
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await page.getByRole('link', { name: /New chart from/ }).click();
  await expect(page.getByRole('heading', { name: 'New chart' })).toBeVisible();
  await look('new chart');
  // A chart once it has been drawn, with its picture and the record of how it was made.
  await page.getByLabel('Name', { exact: true }).fill('latency');
  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('line');
  await page.getByRole('button', { name: 'Draw the chart' }).click();
  await expect(page.getByRole('img', { name: /^Line chart of/ })).toBeVisible({ timeout: 30_000 });
  await look('a drawn chart');
  // The differences between two revisions.
  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('First');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');
  await page.getByRole('link', { name: 'refs.bib' }).first().click();
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );
  await page.locator('.editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(
    '% a line long enough that it would not fit across a narrow window without wrapping or scrolling\n',
  );
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );
  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('Second');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByRole('link', { name: 'Changes since 1' }).click();
  await expect(page.getByRole('heading', { name: 'Revision 1 to revision 2' })).toBeVisible();
  await look('differences between revisions');
  await page.goto(`${paper}/submit`);
  await expect(page.getByRole('heading', { name: /before submitting/ })).toBeVisible();
  await look('checks before submitting');
  await page.goto(paper);
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });
  await look('editor, visual view');
  await showSource(page);
  await look('editor, source view');
  expect(found).toEqual([]);
});
