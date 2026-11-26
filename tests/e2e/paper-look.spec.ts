// The paper page (apps/web/app/projects/[id]): the checks that matter to how it reads, not what
// it does (the other specs do that).
import { expect, type Page, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { audit, person, run, signIn, sticksOut } from './helpers';
import { enlarged, lost, spaced } from './look';

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Results}\\label{sec:r}',
  'Latency stays below forty milliseconds~\\cite{knuth1984}, see Section~\\ref{sec:r}.',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');
const BIB = '@book{knuth1984, author = {Donald Knuth}, title = {The TeXbook}, year = 1984}\n';
const CSV = 'day,latency (ms)\n2024-03-01,9\n2024-03-02,38\n';
const SHOTS = process.env.PAPER_LOOK_SHOTS;

/** A paper with files, data, a bibliography, two revisions and an invitation, as its owner sees it. */
async function paperWithEverything(page: Page, email: string) {
  await page.goto('/sign-in');
  await signIn(page, email);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Look ${run}.zip`);
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
  await page.getByLabel('Name for the paper as it is now').fill('First draft');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');
  await page.getByLabel('Their email address').fill(`guest-${run}@example.org`);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText('Invitation sent');
  return page.url().split('?')[0];
}

test('the paper page is in the new look, passes the audit, and has not got wider than the window', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'paper-look');
  const paper = await paperWithEverything(page, email);
  await page.goto(paper);
  await expect(page.locator('main')).toHaveAttribute('data-ui', 'next');
  await audit(page, 'paper, new look');

  // Where you are, and the one way out: one link named "All papers", no second one.
  await expect(page.getByRole('link', { name: 'All papers' })).toHaveCount(1);
  const bar = page.getByRole('navigation', { name: 'Where you are' });
  await expect(bar.getByRole('link', { name: 'All papers' })).toBeVisible();
  // The first stop in the page is that link.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'All papers' })).toBeFocused();

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.mouse.move(1438, 2);
    await page.screenshot({ path: join(SHOTS, 'paper-1440-full.png'), fullPage: true });
    await page.screenshot({ path: join(SHOTS, 'paper-1440-top.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(SHOTS, 'paper-390-full.png'), fullPage: true });
  }

  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(paper);
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  expect(await sticksOut(page)).toEqual([]);
});

test('the paper page loses nothing when the text is spaced or made twice as big', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'paper-look-zoom');
  const paper = await paperWithEverything(page, email);
  await page.goto(paper);
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  await spaced(page);
  expect(await lost(page)).toEqual([]);
  await page.goto(paper);
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  await enlarged(page);
  expect(await lost(page)).toEqual([]);
});
