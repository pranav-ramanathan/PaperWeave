// Renaming a label: every line it would change is shown first, then all of them change together.
// Needs Docker, the TeX image, the services, the sync server and the build worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { audit, person, run, showSource, signIn, sourceText } from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');
const source = (page: Page) => page.locator('.editor .cm-content');
const alert = (page: Page) => page.locator('main [role=alert]');

test('a label is renamed with every reference, after the changes have been shown', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'label-owner');
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Labels ${run}.zip`);
  writeFileSync(zip, await writeZip(files));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  // Someone has the file with the reference open while all this happens.
  const other = await page.context().newPage();
  await other.goto(paper);
  await other.getByRole('link', { name: 'sections/intro.tex' }).click();
  await showSource(other);
  await expect(source(other)).toContainText('\\ref{sec:method}');

  const ask = async (from: string, to: string) => {
    await page.goto(paper);
    await page.getByLabel('Rename the label').selectOption(from);
    await page.getByLabel('to', { exact: true }).fill(to);
    await page.getByRole('button', { name: 'See what would change' }).click();
  };
  // A name that is taken, or that LaTeX could not use, is refused with the reason.
  await ask('sec:method', 'sec:intro');
  await expect(alert(page)).toHaveText('There is already a label called sec:intro.');
  await ask('sec:method', 'two words');
  await expect(alert(page)).toContainText('A label name is 1 to 200 characters');

  // The changes are listed, file by file, and nothing has changed yet.
  await ask('sec:method', 'sec:design');
  await expect(
    page.getByRole('heading', { name: 'Rename sec:method to sec:design' }),
  ).toBeVisible();
  await expect(page.getByText('This would change 2 lines in 2 files')).toBeVisible();
  await audit(page, 'the lines a label rename would change');
  const intro = page.getByRole('region', { name: 'sections/intro.tex' });
  await expect(intro).toContainText(
    '- 16: The rest of the paper is organised as follows. Section~\\ref{sec:method} gives the',
  );
  await expect(intro).toContainText(
    '+ 16: The rest of the paper is organised as follows. Section~\\ref{sec:design} gives the',
  );
  await expect(page.getByRole('region', { name: 'sections/method.tex' })).toContainText(
    '+ 2: \\label{sec:design}',
  );
  await expect(source(other)).toContainText('\\ref{sec:method}');

  // Meanwhile another reference is typed. The rename is not carried out on a list that is no
  // longer the whole truth: the changes are shown again, now with the new line.
  await source(other).click();
  await other.keyboard.press('ControlOrMeta+End');
  await other.keyboard.type('\nAgain, see Section~\\ref{sec:method}.');
  await expect(other.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );
  await page.getByRole('button', { name: 'Rename in all 2 files' }).click();
  await expect(alert(page)).toHaveText('The paper has changed since. Look at the changes again.');
  await expect(page.getByText('This would change 3 lines in 2 files')).toBeVisible();
  await page.getByRole('button', { name: 'Rename in all 2 files' }).click();
  await expect(page.getByRole('status')).toHaveText('Renamed to sec:design in 3 places.');
  await expect(page.getByText('7 labels. Every reference points to one of them.')).toBeVisible();

  // The open editor has the new name in both places, without a reload.
  await expect(source(other)).toContainText('Section~\\ref{sec:design} gives the');
  await expect(source(other)).toContainText('Again, see Section~\\ref{sec:design}.');
  await expect(source(other)).not.toContainText('sec:method');
  // And the PDF still resolves it: same number as before, no "??".
  await other.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Visual' }).click();
  await expect(other.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 60_000,
  });
  const reference = other.locator('.pw-ref[aria-label^="reference to sec:design:"]');
  await expect(reference).toHaveCount(2);
  await expect(reference.first()).toHaveText('II');
});

test('a label named after a comment in a list is renamed, and the bibliography lists what \\shortcite cites', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { page, email } = await person(browser, 'label-comment');
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{A}\\label{fig:a}',
    '\\section{B}\\label{fig:b}',
    'See \\cref{fig:a,% first',
    '  fig:b}.',
    '\\cpagerefrange{fig:a}{fig:b} and \\shortcite{knuth1984}.',
    '\\bibliography{refs}',
    '\\end{document}',
    '',
  ].join('\n');
  const bib = '@article{knuth1984, author = {Knuth, Donald E.}, title = {Literate Programming}}\n';
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Comment list ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(main) },
      { path: 'refs.bib', bytes: Buffer.from(bib) },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  // The citation the paper makes with \shortcite counts: its entry is listed in the table.
  await expect(page.getByText('1 entry. Every citation has one.')).toBeVisible();
  await expect(page.getByText(/not cited in it/)).toHaveCount(0);
  await expect(page.getByRole('row', { name: /^knuth1984/ })).toHaveCount(1);
  await expect(page.getByText('2 labels. Every reference points to one of them.')).toBeVisible();

  await page.getByLabel('Rename the label').selectOption('fig:b');
  await page.getByLabel('to', { exact: true }).fill('fig:second');
  await page.getByRole('button', { name: 'See what would change' }).click();
  await expect(page.getByText('This would change 3 lines in 1 file')).toBeVisible();
  const lines = page.getByRole('region', { name: 'main.tex' });
  await expect(lines).toContainText('+ 4: \\section{B}\\label{fig:second}');
  await expect(lines).toContainText('+ 6:   fig:second}.');
  await expect(lines).toContainText('+ 7: \\cpagerefrange{fig:a}{fig:second}');
  await audit(page, 'a label rename over a comment in a list');
  await page.getByRole('button', { name: 'Rename in all of it' }).click();
  await expect(page.getByRole('status')).toHaveText('Renamed to fig:second in 3 places.');

  await page.goto(paper);
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(page);
  await expect(page.locator('.editor .cm-content')).toContainText('fig:second}');
  const text = await sourceText(page);
  expect(text).toContain('% first');
  expect(text).toContain('fig:second}');
  expect(text).not.toContain('fig:b');
});
