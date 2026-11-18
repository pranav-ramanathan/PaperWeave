// A paper is restored while someone is offline with edits of their own. When they come back the
// edits are neither lost nor merged behind their back: they choose.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { emailedLink, person, run, showSource, signIn } from './helpers';

const MAIN = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
const source = (page: Page) => page.locator('.editor .cm-content');
const status = (page: Page) =>
  page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
async function typeAtStart(page: Page, text: string) {
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type(text);
}

test('edits made offline across a restore are held until their author decides', async ({
  browser,
}) => {
  const owner = await person(browser, 'rec-owner');
  const editor = await person(browser, 'rec-editor');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Recover ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));

  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByLabel('Their email address').fill(editor.email);
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(editor.email);
  await owner.page.getByLabel('Name for the paper as it is now').fill('Good');
  await owner.page.getByRole('button', { name: 'Save revision' }).click();
  await expect(owner.page.getByRole('status')).toHaveText('Saved as revision 1.');
  const paper = owner.page.url().split('?')[0];
  // The owner watches the file in a second tab.
  const watch = await owner.page.context().newPage();
  await watch.goto(paper);
  await watch.getByRole('link', { name: 'main.tex' }).click();
  await showSource(watch);

  await editor.page.goto(await emailedLink(editor.email, '/invitations/'));
  await signIn(editor.page, editor.email);
  await editor.page.getByRole('button', { name: 'Join this paper' }).click();
  await editor.page.getByRole('link', { name: 'main.tex' }).click();
  await showSource(editor.page);
  await typeAtStart(editor.page, '% regretted\n');
  await expect(status(editor.page)).toHaveText('All edits saved.');
  await expect(source(watch)).toContainText('% regretted');

  const restore = async () => {
    await owner.page.goto(paper);
    await owner.page.getByRole('button', { name: 'Restore revision 1' }).click();
    await expect(owner.page.getByRole('status')).toContainText('Restored.');
    await expect(source(watch)).not.toContainText('% regretted');
  };
  const choice = (name: RegExp) => editor.page.getByRole('button', { name });

  // Offline with nothing unsent: coming back simply shows the restored text.
  await editor.page.context().setOffline(true);
  await expect(status(editor.page)).toContainText('Offline.');
  await restore();
  await editor.page.context().setOffline(false);
  await expect(status(editor.page)).toHaveText('All edits saved.', { timeout: 30_000 });
  await expect(source(editor.page)).not.toContainText('% regretted');
  await expect(choice(/Apply my edits/)).toHaveCount(0);

  // Offline with an unsent edit: on return it is held, and nobody else has it.
  await typeAtStart(editor.page, '% regretted\n');
  await expect(status(editor.page)).toHaveText('All edits saved.');
  await editor.page.context().setOffline(true);
  await expect(status(editor.page)).toContainText('Offline.');
  await typeAtStart(editor.page, '% typed offline\n');
  await restore();
  await editor.page.context().setOffline(false);
  await expect(status(editor.page)).toContainText('was restored to an earlier revision', {
    timeout: 30_000,
  });
  await expect(status(editor.page)).toContainText('not saved');
  await expect(source(editor.page)).toHaveAttribute('contenteditable', 'false');
  await expect(source(watch)).not.toContainText('% typed offline');
  // Applying them merges them into the restored text.
  await choice(/Apply my edits/).click();
  await expect(status(editor.page)).toHaveText('All edits saved.', { timeout: 30_000 });
  await expect(source(watch)).toContainText('% typed offline');
  await expect(source(watch)).not.toContainText('% regretted');
  await expect(source(editor.page)).toHaveAttribute('contenteditable', 'true');

  // The same again, but this time the edits are discarded.
  await editor.page.context().setOffline(true);
  await expect(status(editor.page)).toContainText('Offline.');
  await typeAtStart(editor.page, '% to be discarded\n');
  await restore();
  await editor.page.context().setOffline(false);
  await expect(choice(/Discard my edits/)).toBeVisible({ timeout: 30_000 });
  await choice(/Discard my edits/).click();
  await showSource(editor.page);
  await expect(status(editor.page)).toHaveText('All edits saved.', { timeout: 30_000 });
  await expect(source(editor.page)).toContainText('Hello.');
  await expect(source(editor.page)).not.toContainText('% to be discarded');
  await expect(source(watch)).not.toContainText('% to be discarded');
});
