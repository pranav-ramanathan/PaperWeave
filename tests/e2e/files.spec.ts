// Files in the app: start a paper from nothing, add a blank file and an upload, choose the root,
// delete a file someone has open, and bring it back.
// Needs Docker, the TeX image, the services, the sync server and the build worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { dropOn, person, run, selectWord, showSource, signIn, typingSaved } from './helpers';

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

  // A file dropped on the page is not opened in its place, which would leave the app. The one
  // field for choosing a file takes a dropped file itself, so that is left alone.
  const picture = {
    name: 'p.png',
    type: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  };
  expect(await dropOn(page.locator('main').first(), { file: picture })).toEqual({
    over: true,
    drop: true,
  });
  expect((await dropOn(page.getByLabel(/^A file to upload/), { file: picture })).drop).toBe(false);

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
  // Started blank and written since: the page says how large it is now, not "0 B".
  await expect(main.getByRole('cell').first()).toHaveText(/^[1-9]\d* B$/);
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

test('a page come back to says what is so now', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'files-back');
  const page = owner.page;
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Back ${run}.zip`);
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'Latency stays below forty milliseconds for most edits.',
    '',
    '\\input{body}',
    '\\end{document}',
    '',
  ].join('\n');
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(main) },
      { path: 'body.tex', bytes: Buffer.from('Nothing else is claimed here.\n') },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);

  // A thread started meanwhile is listed on the paper's page reached with Back.
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await page.waitForURL(/\/files\//);
  const comments = page.getByRole('region', { name: 'Comments' });
  await selectWord(page, '.editor .visual .ProseMirror', 'forty');
  await comments.getByRole('button', { name: 'Comment on the selected text' }).click();
  await comments.getByLabel('Comment', { exact: true }).fill('Is that the median?');
  await comments.getByRole('button', { name: 'Start thread' }).click();
  await expect(page.getByRole('article', { name: 'Thread on “forty”' })).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole('listitem').filter({ hasText: 'the latest by' })).toContainText(
    'main.tex: forty.',
  );

  // A file deleted meanwhile is gone from the page reached with Back.
  await page.getByRole('button', { name: 'Delete body.tex' }).click();
  await expect(page.getByRole('status')).toContainText('Deleted body.tex');
  await page.goBack();
  await expect(page.getByRole('link', { name: 'body.tex', exact: true })).toHaveCount(0);

  // Words typed with no connection, then Back and Forward: the editor is the same one, and the
  // words are saved when the connection returns.
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await page.waitForURL(/\/files\//);
  await showSource(page);
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  await expect(source(page)).toContainText('forty');
  await source(page).click();
  await page.context().setOffline(true);
  await expect(editorStatus(page)).toContainText('Offline.');
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('offlineword ');
  await expect(editorStatus(page)).toContainText('waiting to be saved');
  // Leaving the file's page and coming back starts its editor afresh, refresh or none, so Back
  // here is a step in the page's own history.
  await page.evaluate(() => history.pushState(null, '', '#again'));
  await page.goBack();
  await page.goForward();
  await page.context().setOffline(false);
  await expect(source(page)).toContainText('offlineword');
  await typingSaved(page);
  await expect(source(page)).toContainText('offlineword');
  // Back on its page with the connection returned, the editor has not been asked for again.
  await page.evaluate(() => history.pushState(null, '', '#once-more'));
  await page.goBack();
  await expect(source(page)).toContainText('offlineword');
  await expect(editorStatus(page)).toHaveText('All edits saved.');

  // A document that has never held an editor, taken to another page and brought back with Back:
  // the refresh gives the layout a new number, and the editor opened next must still be allowed.
  const paperPage = page.url().replace(/\/files\/.*$/, '');
  const fresh = await page.context().newPage();
  await fresh.goto(paperPage);
  await fresh.getByRole('link', { name: 'All papers' }).click();
  await fresh.waitForURL(/\/projects$/);
  await fresh.goBack();
  await fresh.waitForTimeout(1000);
  await fresh.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(fresh);
  await expect(editorStatus(fresh)).toHaveText('All edits saved.');
});
