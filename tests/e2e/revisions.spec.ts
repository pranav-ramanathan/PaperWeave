// Revisions in the app: save, build, download, compare, restore, rename.
// Needs Docker, the TeX image, the services, the sync server and the build worker.
import { execFileSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { person, run, showSource, signIn } from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/article-basic');
const source = (page: Page) => page.locator('.editor .cm-content');
const editorStatus = (page: Page) =>
  page.getByRole('region', { name: /^Editor for/ }).getByRole('status');

test('save a revision, build and download it, compare, restore and rename', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'rev-owner');
  const page = owner.page;
  const files: { path: string; bytes: Buffer }[] = [];
  for (const f of readdirSync(FIXTURE))
    if (statSync(join(FIXTURE, f)).isFile())
      files.push({
        path: relative(FIXTURE, join(FIXTURE, f)),
        bytes: readFileSync(join(FIXTURE, f)),
      });
  const dir = mkdtempSync(join(tmpdir(), 'paperweave-e2e-'));
  writeFileSync(join(dir, `Revs ${run}.zip`), await writeZip(files));

  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page
    .getByLabel('Or import a ZIP of a LaTeX project')
    .setInputFiles(join(dir, `Revs ${run}.zip`));
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();

  // Save the paper as it is, and build that exact revision.
  await page.getByLabel('Name for the paper as it is now').fill('As uploaded');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');
  await page.getByRole('button', { name: 'Build the PDF for revision 1' }).click();
  const first = page.getByRole('row', { name: /1\. As uploaded/ });
  await expect(async () => {
    await page.goto(paper);
    await expect(first.getByRole('link', { name: 'PDF' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  const pdf = await page.request.get(
    (await first.getByRole('link', { name: 'PDF' }).getAttribute('href'))!,
  );
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  // Its ZIP holds the uploaded bytes and says how to rebuild it.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    first.getByRole('link', { name: 'ZIP with build details' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`Revs ${run} r1.zip`);
  const zipPath = await download.path();
  const read = (name: string) => execFileSync('unzip', ['-p', zipPath, name]);
  expect(read('main.tex').equals(files.find((f) => f.path === 'main.tex')!.bytes)).toBe(true);
  expect(JSON.parse(read('paperweave-toolchain.json').toString())).toMatchObject({
    revision: 1,
    root: 'main.tex',
    compiler: 'pdflatex',
  });

  // Edit, save again, and see exactly what changed.
  await page.getByRole('link', { name: 'main.tex' }).click();
  await showSource(page);
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('% a regrettable first line\n');
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('With a regret');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByRole('link', { name: 'Changes since 1' }).click();
  await expect(page.getByRole('heading', { name: 'Revision 1 to revision 2' })).toBeVisible();
  await expect(page.locator('.diff .added')).toHaveText('+ % a regrettable first line\n');
  await expect(page.locator('.diff .removed')).toHaveCount(0);

  // Restore the first revision: the editor shows the original text again.
  await page.goto(paper);
  await page.getByRole('button', { name: 'Restore revision 1' }).click();
  await expect(page.getByRole('status')).toHaveText('Restored. The paper is now revision 3.');
  await expect(page.getByRole('row', { name: /3\. Restore of revision 1/ })).toBeVisible();
  await page.getByRole('link', { name: 'main.tex' }).click();
  await showSource(page);
  await expect(source(page)).toContainText('Synthetic fixture');
  await expect(source(page)).not.toContainText('regrettable');

  // Rename a file: the new name shows, a bad one is refused with a reason.
  await page.goto(paper);
  const bib = page.getByRole('row', { name: /refs\.bib/ });
  await bib.locator('summary').click();
  await bib.getByLabel('New name for refs.bib').fill('../outside.bib');
  await bib.getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('main [role=alert]')).toContainText('That name cannot be used');
  const again = page.getByRole('row', { name: /refs\.bib/ });
  await again.locator('summary').click();
  await again.getByLabel('New name for refs.bib').fill('bibliography/refs.bib');
  await again.getByRole('button', { name: 'Rename' }).click();
  // The root file names this one, so the line that would change is shown before anything does.
  await expect(page.getByText('1 line names this file.')).toBeVisible();
  const change = page.getByRole('region', { name: 'main.tex' });
  await expect(change).toContainText('\\bibliography{refs}');
  await expect(change).toContainText('\\bibliography{bibliography/refs}');
  await page.getByRole('button', { name: 'Rename and update that line' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Renamed to bibliography/refs.bib, and updated 1 place that names it.',
  );
  await expect(page.getByRole('row', { name: /bibliography\/refs\.bib/ })).toBeVisible();
  // The paper still builds: the line that named the file names it still.
  await page.getByRole('link', { name: 'main.tex' }).click();
  await showSource(page);
  await expect(source(page)).toContainText('\\bibliography{bibliography/refs}');
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 60_000,
  });
});
