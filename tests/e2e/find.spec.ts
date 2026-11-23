// Find and replace in the source editor: finding text the editor has not drawn, replacing it for
// everyone as one undo step, and a reviewer who can look but not change. Needs the services in
// infra/compose.yaml and the sync server.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import {
  audit,
  emailedLink,
  person,
  run,
  showSource,
  showVisual,
  signIn,
  typingSaved,
} from './helpers';

const LINES = 400;
const COLOUR = [100, 200, 300];
/** A file longer than the editor can draw at once: the far word is line 380, the near one line 3. */
function longFile() {
  const lines = ['\\documentclass{article}', '\\begin{document}', 'needle-near is here.'];
  for (let n = lines.length + 1; n <= LINES; n++) {
    lines.push(
      n === 380
        ? 'needle-far is here.'
        : COLOUR.includes(n)
          ? `The colour of line ${n}.`
          : `Filler sentence number ${n} of the paper.`,
    );
  }
  lines.push('\\end{document}', '');
  return lines.join('\n');
}

const source = (page: Page) => page.locator('.editor .cm-content');
const panel = (page: Page) => page.locator('.editor .cm-search');
const findBox = (page: Page) => page.getByRole('textbox', { name: 'Find' });

async function importLong(page: Page, who: string) {
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Find ${who} ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(longFile()) }]));
  await page.goto('/sign-in');
  await signIn(page, `${who}-${run}@example.org`);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(page);
  await expect(source(page)).toContainText('needle-near');
}

async function invite(owner: Page, who: { page: Page; email: string }, role: string) {
  await owner.getByRole('link', { name: 'Paper overview' }).click();
  await owner.getByLabel('Their email address').fill(who.email);
  await owner.getByLabel('Their role').selectOption(role);
  await owner.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.getByRole('status')).toContainText(who.email);
  await who.page.goto(await emailedLink(who.email, '/invitations/'));
  await signIn(who.page, who.email);
  await who.page.getByRole('button', { name: 'Join this paper' }).click();
  await who.page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(who.page);
  await expect(source(who.page)).toContainText('needle-near');
}

/** The whole text, read by scrolling the editor through the file, since it draws only part. */
async function wholeText(page: Page) {
  return page.locator('.editor .cm-scroller').evaluate(async (scroller) => {
    const seen = new Map<string, string>();
    scroller.scrollTop = 0;
    for (let guard = 0; guard < 400; guard++) {
      await new Promise((r) => setTimeout(r, 60));
      for (const line of scroller.querySelectorAll('.cm-line')) {
        const copy = line.cloneNode(true) as HTMLElement;
        for (const c of copy.querySelectorAll('.cm-ySelectionCaret')) c.remove();
        const text = copy.textContent ?? '';
        const n = /number (\d+)|line (\d+)|needle-(near|far)/.exec(text);
        seen.set(n ? n[0] : text, text);
      }
      const before = scroller.scrollTop;
      scroller.scrollTop += 300;
      if (scroller.scrollTop === before) break;
    }
    scroller.scrollTop = 0;
    return [...seen.values()].join('\n');
  });
}
const count = (text: string, word: string) => text.split(word).length - 1;

test('finds text that is not drawn', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'find-owner');
  await importLong(owner.page, 'find-owner');
  const page = owner.page;

  // The editor draws only the lines near the window, which is why the browser's own find cannot.
  await expect(source(page)).not.toContainText('needle-far');

  await source(page).click();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(findBox(page)).toBeFocused();
  await findBox(page).pressSequentially('needle-far');
  await page.keyboard.press('Enter');
  await expect(source(page)).toContainText('needle-far');
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('needle-far');

  // Previous and next keep working from the keyboard.
  await page.keyboard.press('Shift+Enter');
  await expect(source(page)).toContainText('needle-far');
  await page.keyboard.press('F3');
  await expect(source(page)).toContainText('needle-far');
});

test('replace all is shared, saved and one undo step', async ({ browser }) => {
  test.setTimeout(240_000);
  const owner = await person(browser, 'find-rep-owner');
  const editor = await person(browser, 'find-rep-editor');
  await importLong(owner.page, 'find-rep-owner');
  await invite(owner.page, editor, 'editor');
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(owner.page);
  await expect(source(owner.page)).toContainText('needle-near');
  const page = owner.page;

  await source(page).click();
  await page.keyboard.press('ControlOrMeta+f');
  await findBox(page).pressSequentially('colour');
  await page.getByRole('textbox', { name: 'Replace' }).pressSequentially('color');
  await page.getByRole('button', { name: 'Replace all' }).click();
  await typingSaved(page);

  const here = await wholeText(page);
  expect(count(here, 'color')).toBe(3);
  expect(count(here, 'colour')).toBe(0);
  const there = await wholeText(editor.page);
  expect(count(there, 'color')).toBe(3);
  expect(count(there, 'colour')).toBe(0);

  // Saved: the other person's page, loaded afresh, has the new text.
  await editor.page.reload();
  await showSource(editor.page);
  await expect(source(editor.page)).toContainText('needle-near');
  const saved = await wholeText(editor.page);
  expect(count(saved, 'color')).toBe(3);
  expect(count(saved, 'colour')).toBe(0);

  // One Ctrl+Z takes all three back, here and for the other person.
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => count(await wholeText(page), 'colour'), { timeout: 20_000 })
    .toBe(3);
  expect(count(await wholeText(page), 'color')).toBe(0);
  await expect
    .poll(async () => count(await wholeText(editor.page), 'colour'), { timeout: 20_000 })
    .toBe(3);
});

test('a reviewer finds but cannot replace', async ({ browser }) => {
  test.setTimeout(240_000);
  const owner = await person(browser, 'find-rev-owner');
  const reviewer = await person(browser, 'find-rev-reviewer');
  await importLong(owner.page, 'find-rev-owner');
  await invite(owner.page, reviewer, 'reviewer');
  const page = reviewer.page;

  await source(page).click();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(findBox(page)).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Replace' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replace all' })).toHaveCount(0);
  await findBox(page).pressSequentially('needle-far');
  await page.keyboard.press('Enter');
  await expect(source(page)).toContainText('needle-far');
  // Nothing was replaced.
  const text = await wholeText(page);
  expect(count(text, 'colour')).toBe(3);
  expect(count(text, 'color')).toBe(0);
});

test('the button, Escape and the audit', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'find-keys-owner');
  await importLong(owner.page, 'find-keys-owner');
  const page = owner.page;

  await page.getByRole('button', { name: 'Find and replace' }).click();
  await expect(findBox(page)).toBeFocused();
  await audit(page, 'source view with find open');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('.cm-content')))
    .toBe(true);

  await showVisual(page);
  await expect(page.getByRole('button', { name: 'Find and replace' })).toHaveCount(0);
  await page.locator('.editor .visual .ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(panel(page)).toHaveCount(0);
});
