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

  // Coming back online, the first tries to get a ticket fail: the network, not a refusal. The
  // editor does not lock itself; it tries again and carries on.
  let failed = 0;
  await editor.page.route('**/api/sync-ticket**', (route) =>
    failed++ < 2 ? route.abort() : route.continue(),
  );
  await editor.page.context().setOffline(true);
  await expect(status(editor.page)).toContainText('Offline.');
  await typeAtStart(editor.page, '% typed while away\n');
  await editor.page.context().setOffline(false);
  await expect(status(editor.page)).toHaveText('All edits saved.', { timeout: 30_000 });
  expect(failed).toBeGreaterThanOrEqual(3);
  await expect(source(watch)).toContainText('% typed while away');
});

test('an edit too large to save stops the editor, which says so and lets it be discarded', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'rec-large');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Large ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'notes.txt', bytes: Buffer.from('Notes.\n') },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'notes.txt' }).first().click();
  await expect(status(page)).toHaveText('All edits saved.');
  // The same file in a second tab, to see what the server holds.
  const watch = await page.context().newPage();
  await watch.goto(page.url());
  await expect(status(watch)).toHaveText('All edits saved.');

  /** Paste lines of 71 characters into the file, all at once. */
  const paste = async (lines: number) => {
    await source(page).click();
    await source(page).evaluate((el, n) => {
      const data = new DataTransfer();
      data.setData('text/plain', `${'x'.repeat(70)}\n`.repeat(n));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, lines);
  };
  // More than two megabytes: the server reads the edit and refuses it.
  await paste(30_000);
  await expect(status(page)).toContainText('too large to save', { timeout: 30_000 });
  await expect(source(page)).toHaveAttribute('contenteditable', 'false');
  // Nobody else got it, and it is not sent again.
  await typeAtStart(watch, 'Still fine. ');
  await expect(status(watch)).toHaveText('All edits saved.');
  await expect(source(watch)).not.toContainText('xxxx');
  await expect(status(page)).toContainText('too large to save');

  // Discarded, the editor starts again from what the server holds.
  await page.getByRole('button', { name: 'Discard my edits' }).click();
  await expect(status(page)).toHaveText('All edits saved.', { timeout: 30_000 });
  // (The other tab's caret is shown in the text, between the two.)
  await expect(source(page)).toContainText(/Still fine\. .*Notes\./);
  await expect(source(page)).not.toContainText('xxxx');
  await typeAtStart(page, 'And on. ');
  await expect(source(watch)).toContainText(/And on\. .*Still fine\. .*Notes\./);

  // More than the server reads off the wire at all: it closes the connection instead. The editor
  // takes that the same way, and does not connect again to send it again.
  await paste(60_000);
  await expect(status(page)).toContainText('too large to save', { timeout: 30_000 });
  await typeAtStart(watch, 'Even so. ');
  await expect(status(watch)).toHaveText('All edits saved.');
  await expect(source(watch)).not.toContainText('xxxx');
  await expect(status(page)).toContainText('too large to save');
});

test('a file takes no typing until it has arrived', async ({ browser }) => {
  const { page, email } = await person(browser, 'rec-early');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Early ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();

  // The connection is kept waiting, as a slow network would keep it.
  let letIn!: () => void;
  const waiting = new Promise<void>((done) => (letIn = done));
  await page.route('**/api/sync-ticket**', async (route) => {
    await waiting;
    await route.continue();
  });
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(page);
  await expect(status(page)).toHaveText('Opening…');
  // The editor is empty and shut. Typed into, the words would land at the top of the file
  // once it arrived, wherever they were meant to go.
  await expect(source(page)).toHaveAttribute('contenteditable', 'false');
  await source(page).click();
  await page.keyboard.type('% typed too early\n');

  letIn();
  await expect(status(page)).toHaveText('All edits saved.');
  await expect(source(page)).toContainText('Hello.');
  await expect(source(page)).not.toContainText('too early');
  await expect(source(page)).toHaveAttribute('contenteditable', 'true');
  await typeAtStart(page, '% typed in time\n');
  await expect(status(page)).toHaveText('All edits saved.');
  await expect(source(page)).toContainText('% typed in time');
});

test('a file is opened over one connection, which is kept', async ({ browser }) => {
  const { page, email } = await person(browser, 'rec-once');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Once ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();

  // Every connection the page makes from here on, and whether it has closed.
  const connections: { closed: boolean }[] = [];
  page.on('websocket', (socket) => {
    const made = { closed: false };
    connections.push(made);
    socket.on('close', () => void (made.closed = true));
  });
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(page);
  await expect(status(page)).toHaveText('All edits saved.');
  // The editor once dropped its first connection a second after making it and made another:
  // what the server answered in that moment was lost. Typed across that second, an edit's
  // "saved" could fail to arrive.
  await typeAtStart(page, '% typed in the first second\n');
  await page.waitForTimeout(2000);
  expect(connections).toEqual([{ closed: false }]);
  await expect(status(page)).toHaveText('All edits saved.');
});
