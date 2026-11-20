// The checks before submitting: what is wrong with the paper is listed with its place, and once
// nothing is, the ZIP and the PDF of one revision are offered. Needs the services, the sync
// server and the worker.
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { caretLine, clickAfter, person, run, showSource, signIn, typingSaved } from './helpers';

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Introduction}',
  'As Section~\\ref{sec:intro} says.',
  '\\end{document}',
  '',
].join('\n');

test('a paper is checked before submitting, put right, and downloaded as one revision', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'submit-owner');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Submit ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'Check before submitting' }).click();
  await expect(
    page.getByRole('heading', { name: /^Check Submit .* before submitting$/ }),
  ).toBeVisible();
  const submit = page.url();

  // Two things stand in the way, and nothing is offered for download.
  const problems = page.getByRole('listitem');
  await expect(problems).toHaveText([
    /\\ref\{sec:intro\} refers to a label the paper does not have\. main\.tex, line 4/,
    'The paper has not been built yet.',
  ]);
  await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0);

  // The finding leads to the file. The label is added there.
  await page.getByRole('link', { name: 'main.tex, line 4' }).click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  // And to the line: the caret is on it.
  await expect(page).toHaveURL(/line=4$/);
  await showSource(page);
  await expect.poll(() => caretLine(page)).toBe(4);
  await clickAfter(page, '.editor .cm-content', 'Introduction}');
  await page.keyboard.type('\\label{sec:intro}');
  await typingSaved(page);

  // Built again from the page. It looks again by itself until the build is done.
  await page.goto(submit);
  const ready = page.getByText('Nothing stands in the way.');
  const again = page.getByRole('button', { name: 'Build the paper and check again' });
  // The editor may have asked for a build already; then there is nothing to press yet.
  await expect(again.or(ready).first()).toBeVisible({ timeout: 60_000 });
  if (!(await ready.isVisible())) await again.click();
  await expect(ready).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'To put right' })).toHaveCount(0);

  // The PDF and the ZIP are of the same revision: the ZIP has the label that was just added.
  const fetched = async (name: string) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name, exact: true }).click(),
    ]);
    return readFileSync(await download.path());
  };
  const files = (await readZip(await fetched('Download the ZIP'))).entries;
  expect(Buffer.from(files.find((f) => f.path === 'main.tex')!.bytes).toString()).toContain(
    '\\section{Introduction}\\label{sec:intro}',
  );
  const pdf = await page.request.get(
    (await page.getByRole('link', { name: 'Download the PDF' }).getAttribute('href'))!,
  );
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('a paper with a hand-written bibliography is ready once built, and offers its downloads', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'submit-thebib');
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'As \\cite{one} and \\cite{two} say.',
    '\\begin{thebibliography}{9}',
    '\\bibitem{one} A. One. First. 2001.',
    '\\bibitem[Two(2002)]{two} B. Two. Second. 2002.',
    '\\end{thebibliography}',
    '\\end{document}',
    '',
  ].join('\n');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Handbib ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'Check before submitting' }).click();
  const ready = page.getByText('Nothing stands in the way.');
  const again = page.getByRole('button', { name: 'Build the paper and check again' });
  await expect(again.or(ready).first()).toBeVisible({ timeout: 60_000 });
  if (!(await ready.isVisible())) await again.click();
  await expect(ready).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'To put right' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download the ZIP', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download the PDF', exact: true })).toBeVisible();
});
