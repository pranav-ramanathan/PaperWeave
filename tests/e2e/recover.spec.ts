// A paper is restored while someone is offline with edits of their own. When they come back the
// edits are neither lost nor merged behind their back: they choose.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import {
  audit,
  clickAfter,
  emailedLink,
  person,
  run,
  showSource,
  signIn,
  sticksOut,
} from './helpers';

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
  await audit(editor.page, 'an editor holding edits made before a restore');
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
  await audit(page, 'an editor holding an edit too large to save');
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
  // The connection to the sync server is kept waiting, as a slow network would keep it. What
  // the page sends meanwhile is passed on once it is let through. (Set up before any page is
  // loaded: it takes hold of the connections of pages loaded after it.)
  let letIn!: () => void;
  const waiting = new Promise<void>((done) => (letIn = done));
  await page.routeWebSocket(/:4100/, async (socket) => {
    const held: (string | Buffer)[] = [];
    socket.onMessage((message) => void held.push(message));
    await waiting;
    const server = socket.connectToServer();
    for (const message of held) server.send(message);
    socket.onMessage((message) => server.send(message));
  });
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();

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

test('a structural edit whose answer is lost is made once, and not said to have failed', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'rec-lost');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Lost ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  // The server's first answer to a structural edit never reaches the page, as when a
  // connection drops between the edit and its answer. (Set up before any page is loaded:
  // it takes hold of the connections of pages loaded after it.)
  let lost = 0;
  await page.routeWebSocket(/:4100/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (!lost && Buffer.from(message as Buffer).includes('"result":"applied"'))
        return void lost++;
      socket.send(message);
    });
  });
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();

  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(status(page)).toHaveText('All edits saved.');
  await clickAfter(page, '.editor .visual .ProseMirror', 'Hello');
  await page.getByRole('group', { name: 'Edit' }).getByRole('button', { name: 'Table' }).click();
  const box = page.getByRole('dialog', { name: 'Insert a table' });
  await box.getByLabel('Caption').fill('Lost and found');
  await box.getByRole('button', { name: 'Insert' }).click();

  // The editor asks again under the same key. The server has made the edit and says so, and
  // the window closes without a word of failure.
  await expect(box).toBeHidden({ timeout: 7000 });
  expect(lost).toBe(1);
  await expect(page.locator('main [role=alert]')).toHaveCount(0);
  // Made once, not once for each time it was asked.
  await showSource(page);
  await expect(source(page)).toContainText('\\caption{Lost and found}');
  expect((await source(page).innerText()).split('\\begin{table}').length - 1).toBe(1);
});

test('an editor whose sign-in has ended says so, keeps what is typed, and carries on after signing in', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'rec-signed-out');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Signed out ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(page);
  await expect(status(page)).toHaveText('All edits saved.');

  // Signed out, as from another tab. The editor opened under that sign-in is told at once, with
  // no need for its connection to drop first. Not "you no longer have access": more can be
  // typed, it is kept, and there is a way back in.
  const out = await page.request.post('/api/auth/sign-out', {
    headers: { origin: 'http://localhost:3100' },
    data: {},
  });
  expect(out.ok()).toBe(true);
  await expect(status(page)).toHaveText(
    'You are signed out. Sign in again in another tab and this page will carry on.',
    { timeout: 20_000 },
  );
  await typeAtStart(page, '% typed while signed out\n');
  await expect(status(page)).toHaveText(
    'You are signed out. Sign in again in another tab and this page will carry on. Your edits are kept here until then.',
  );
  await expect(source(page)).toHaveAttribute('contenteditable', 'true');
  await expect(source(page)).toContainText('% typed while signed out');
  await audit(page, 'an editor whose person is signed out');
  const link = page
    .getByRole('region', { name: /^Editor for/ })
    .getByRole('link', { name: 'Sign in (opens a new tab)' });
  const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  await signIn(tab, email);

  // The page left open carries on by itself, and what was typed is saved.
  await expect(status(page)).toHaveText('All edits saved.', { timeout: 20_000 });
  await tab.goto(page.url());
  await showSource(tab);
  await expect(source(tab)).toContainText('% typed while signed out');
});

test('a page left open by one person does not carry on as the next person to sign in', async ({
  browser,
}) => {
  const first = await person(browser, 'rec-first');
  const second = await person(browser, 'rec-second');
  const { page } = first;
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Shared ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.goto('/sign-in');
  await signIn(page, first.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  // The second person may edit the paper too: nothing but the page being someone else's
  // stands between them and it.
  await page.getByLabel('Their email address').fill(second.email);
  await page.getByLabel('Their role').selectOption('editor');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText(second.email);
  await second.page.goto(await emailedLink(second.email, '/invitations/'));
  await signIn(second.page, second.email);
  await second.page.getByRole('button', { name: 'Join this paper' }).click();

  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(page);
  await expect(status(page)).toHaveText('All edits saved.');
  const out = await page.request.post('/api/auth/sign-out', {
    headers: { origin: 'http://localhost:3100' },
    data: {},
  });
  expect(out.ok()).toBe(true);
  await expect(status(page)).toContainText('You are signed out.', { timeout: 20_000 });
  await typeAtStart(page, '% typed by the first person\n');
  await expect(status(page)).toContainText('Your edits are kept here until then.');

  // The second person signs in on the same browser.
  const tab = await page.context().newPage();
  await tab.goto('/sign-in');
  await signIn(tab, second.email);
  // The first person's page stops. What they typed is not saved under the second's name.
  await expect(status(page)).toHaveText(
    'You no longer have access to this file, or it has been deleted.',
    { timeout: 20_000 },
  );
  await tab.goto(page.url());
  await showSource(tab);
  await expect(status(tab)).toHaveText('All edits saved.');
  await expect(source(tab)).toContainText('Hello.');
  await expect(source(tab)).not.toContainText('typed by the first person');
});

test('someone whose role changes while a file is open is told, and does not type into nothing', async ({
  browser,
}) => {
  const owner = await person(browser, 'rec-role-owner');
  const editor = await person(browser, 'rec-role-editor');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Roles ${run}.zip`);
  // Long enough to need scrolling, so that the checks below see whether someone who cannot
  // edit can still get about in it.
  const long = MAIN.replace(
    'Hello.',
    Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of a long paper.\n`).join('\n'),
  );
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(long) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByLabel('Their email address').fill(editor.email);
  await owner.page.getByLabel('Their role').selectOption('editor');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(editor.email);
  const { page } = editor;
  await page.goto(await emailedLink(editor.email, '/invitations/'));
  await signIn(page, editor.email);
  await page.getByRole('button', { name: 'Join this paper' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(page);
  await expect(status(page)).toHaveText('All edits saved.');
  const make = async (role: string) => {
    await owner.page.reload();
    await owner.page.getByLabel(`Role of ${editor.email}`).selectOption(role);
    await owner.page
      .getByRole('row', { name: editor.email })
      .getByRole('button', { name: 'Change' })
      .click();
    await expect(owner.page.getByRole('status')).toContainText('Role changed');
  };

  // Lowered while the file is open. The page was made for an editor: without being told, it
  // would take typing and say "saving" for ever.
  await make('viewer');
  await expect(status(page)).toHaveText(
    'You are now a viewer on this paper and can no longer edit. Reload the page to carry on.',
  );
  await expect(source(page)).toHaveAttribute('contenteditable', 'false');
  await audit(page, 'an editor whose person can no longer edit');
  // Given back what they had: the page carries on as it was.
  await make('editor');
  await expect(status(page)).toHaveText('All edits saved.');
  await typeAtStart(page, '% typed as an editor again\n');
  await expect(status(page)).toHaveText('All edits saved.');

  // Lowered while offline, with something typed meanwhile: told on coming back, and told that
  // it was not saved.
  await page.context().setOffline(true);
  await expect(status(page)).toContainText('Offline.');
  await typeAtStart(page, '% typed offline\n');
  await make('reviewer');
  await page.context().setOffline(false);
  await expect(status(page)).toHaveText(
    'You are now a reviewer on this paper and can no longer edit. What you typed last was not saved. Reload the page to carry on.',
    { timeout: 20_000 },
  );
  // The longest thing the editor's bar ever says, with a button beside it: in a narrow window
  // it wraps, and the page still does not have to be scrolled sideways.
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await sticksOut(page)).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page
    .getByRole('region', { name: /^Editor for/ })
    .getByRole('button', { name: 'Reload the page' })
    .click();
  // Someone who can only read: in the view they arrive in, and in the source.
  await expect(status(page)).toHaveText('Read only. You can read along but not edit.');
  await audit(page, 'the visual view for someone who cannot edit');
  await showSource(page);
  await audit(page, 'the source view for someone who cannot edit');
  // The source can be reached and moved through with the keyboard alone.
  await source(page).focus();
  await expect(source(page)).toBeFocused();
  const scroller = page.locator('.editor .cm-scroller');
  const before = await scroller.evaluate((el) => el.scrollTop);
  await page.keyboard.press('ControlOrMeta+End');
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  await page.keyboard.press('ControlOrMeta+Home');
  // And selected from, to copy: here the first two lines.
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString() ?? ''))
    .toContain('% typed as an editor again');
  await expect(source(page)).toContainText('% typed as an editor again');
  await expect(source(page)).not.toContainText('% typed offline');

  // Raised: the page cannot offer editing without being loaded again, and says so.
  await make('editor');
  await expect(status(page)).toHaveText(
    'You are now an editor on this paper. Reload the page to carry on.',
  );
});
