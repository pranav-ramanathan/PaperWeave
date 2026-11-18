// References and equations in the visual editor carry the numbers LaTeX gave them in the PDF
// on screen. Needs Docker, the TeX image, the services, the sync server and the build worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { person, run, showSource, signIn } from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');
const VISUAL = '.editor .visual .ProseMirror';
const buildStatus = (page: Page) => page.locator('.build').getByRole('status');
const reference = (page: Page, key: string) =>
  page.locator(`${VISUAL} .pw-ref[aria-label^="reference to ${key}:"]`);

test('numbers come from the compiled PDF and follow it when it changes', async ({ browser }) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'num-owner');
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Numbers ${run}.zip`);
  writeFileSync(zip, await writeZip(files));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  // The paper's page counts its labels and finds nothing wrong with them.
  await expect(page.getByText('7 labels. Every reference points to one of them.')).toBeVisible();
  const paper = page.url();

  // Once there is a PDF, a reference shows what the PDF prints. This class numbers sections in
  // Roman numerals.
  await page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });
  await expect(reference(page, 'sec:method')).toHaveText('II');
  await expect(reference(page, 'sec:results')).toHaveText('III');

  // Equations carry their numbers, and references to them match.
  await page.getByRole('link', { name: 'sections/method.tex' }).click();
  await expect(reference(page, 'eq:commute')).toHaveText('(1)');
  await expect(reference(page, 'eq:minimal')).toHaveText('(2)');
  // The renderer puts an equation's row numbers in one column, in order.
  const tags = page.locator(`${VISUAL} .pw-math.pw-block .katex-tag`);
  await expect(tags).toHaveCount(1);
  await expect(tags).toHaveText(/\(1\)\s*\(2\)/);

  // A new first section moves every number along, but only once the PDF has been rebuilt.
  // Until then the old numbers are shown as old.
  await page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await expect(reference(page, 'sec:method')).toHaveText('II');
  await page.getByLabel('Compile automatically').uncheck();
  await showSource(page);
  await page.locator('.editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type(
    '\\section{Preface}\\label{sec:preface}\nSee \\ref{sec:nowhere} and \\cite{nobody2020}.\n\n',
  );
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Visual' }).click();
  await expect(buildStatus(page)).toHaveText('The PDF is behind the text.', { timeout: 30_000 });
  await expect(reference(page, 'sec:method')).toHaveText('II');
  await expect(reference(page, 'sec:method')).toHaveClass(/pw-stale/);
  await page.getByRole('button', { name: 'Compile now' }).click();
  await expect(reference(page, 'sec:method')).toHaveText('III', { timeout: 60_000 });
  await expect(reference(page, 'sec:method')).not.toHaveClass(/pw-stale/);
  await expect(reference(page, 'sec:results')).toHaveText('IV');
  // A reference to a label that does not exist shows what the PDF shows.
  await expect(reference(page, 'sec:nowhere')).toHaveText('??');
  await expect(reference(page, 'sec:nowhere')).toHaveClass(/pw-unknown/);

  // A citation with no entry in the bibliography is marked too, and says so.
  const uncited = page.locator(`${VISUAL} .pw-cite.pw-unknown`);
  await expect(uncited).toHaveText('[nobody2020]');
  await expect(uncited).toHaveAttribute(
    'aria-label',
    'citation: nobody2020: not in the bibliography',
  );

  // The paper's page says where the broken reference is.
  await page.goto(paper);
  await expect(page.getByText('8 labels. Some need attention:')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'sec:nowhere' })).toContainText(
    'sections/intro.tex:2 refers to sec:nowhere, and no label has that name.',
  );
  await expect(page.getByText('1 entry. Some need attention:')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'nobody2020' })).toContainText(
    'sections/intro.tex:2 cites nobody2020, and no entry has that key.',
  );
});
