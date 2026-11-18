// Files in the app: start a paper from nothing, add a blank file and an upload, choose the root,
// delete a file someone has open, and bring it back.
// Needs Docker, the TeX image, the services, the sync server and the build worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { person, run, showSource, signIn } from './helpers';

const source = (page: Page) => page.locator('.editor .cm-content');
const editorStatus = (page: Page) =>
  page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
const buildStatus = (page: Page) => page.locator('.build').getByRole('status');

test('a paper is started from nothing, and a deleted file comes back by restoring', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'files-owner');
  const page = owner.page;
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Name of a new paper').fill(`Scratch ${run}`);
  await page.getByRole('button', { name: 'Create paper' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const paper = page.url();

  // A blank file by name. The first .tex file becomes the root.
  await page.getByLabel('Name, with folders if you like').fill('paper.tex');
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByRole('status')).toHaveText('Added paper.tex.');
  await expect(page.getByRole('row', { name: /paper\.tex/ })).toContainText('Root file');

  // An upload, put in a folder by giving it a name.
  const dir = mkdtempSync(join(tmpdir(), 'paperweave-e2e-'));
  writeFileSync(join(dir, 'intro.tex'), 'Uploaded words.\n');
  await page.getByLabel('Name, with folders if you like').fill('sections/intro.tex');
  await page.getByLabel(/^A file to upload/).setInputFiles(join(dir, 'intro.tex'));
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByRole('status')).toHaveText('Added sections/intro.tex.');

  // Names that would escape the paper, and names already taken, are refused with a reason.
  await page.getByLabel('Name, with folders if you like').fill('../outside.tex');
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('That name cannot be used');
  await page.getByLabel('Name, with folders if you like').fill('paper.tex');
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.locator('p[role=alert]')).toHaveText('Another file already has that name.');

  // Write the paper, and it builds with the uploaded file included.
  await page.getByRole('link', { name: 'paper.tex' }).click();
  await showSource(page);
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  await source(page).click();
  await page.keyboard.type(
    '\\documentclass{article}\n\\begin{document}\nHello.\n\\input{sections/intro}\n\\end{document}\n',
  );
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });

  // The root file cannot be deleted. Another .tex file can be made the root, and back.
  await page.goto(paper);
  const main = page.getByRole('row', { name: /^paper\.tex/ });
  const intro = page.getByRole('row', { name: /sections\/intro\.tex/ });
  await expect(main.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  await intro.getByRole('button', { name: 'Make sections/intro.tex the root file' }).click();
  await expect(page.getByRole('status')).toHaveText('Root file changed.');
  await expect(intro).toContainText('Root file');
  await main.getByRole('button', { name: 'Make paper.tex the root file' }).click();
  await expect(main).toContainText('Root file');

  // Someone has the file open in another tab when it is deleted.
  const other = await page.context().newPage();
  await other.goto(paper);
  await other.getByRole('link', { name: 'sections/intro.tex' }).click();
  await showSource(other);
  await expect(source(other)).toContainText('Uploaded words.');
  await other.locator('.editor .cm-content').click();
  await other.keyboard.press('ControlOrMeta+End');
  await other.keyboard.type('Typed before the delete.');
  await expect(editorStatus(other)).toHaveText('All edits saved.');

  await intro.getByRole('button', { name: 'Delete sections/intro.tex' }).click();
  await expect(page.getByRole('status')).toContainText('Deleted sections/intro.tex.');
  const kept = /Revision (\d+) still has it/.exec(await page.getByRole('status').innerText())![1];
  await expect(page.getByRole('link', { name: 'sections/intro.tex' })).toHaveCount(0);
  await expect(editorStatus(other)).toHaveText(/no longer/);
  await expect(source(other)).toHaveAttribute('contenteditable', 'false');

  // The revision cut by the delete has the file, edit included. Restoring brings it back.
  await page.getByRole('button', { name: `Restore revision ${kept}` }).click();
  await expect(page.getByRole('status')).toContainText('Restored.');
  await page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await showSource(page);
  await expect(source(page)).toContainText('Uploaded words.');
  await expect(source(page)).toContainText('Typed before the delete.');
});
