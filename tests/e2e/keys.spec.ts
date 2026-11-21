// Where the keyboard is after a comment or a proposed change is started, sent and decided. The
// keyboard-only flow in a11y.spec stops at the comment; this carries on. Needs the services, the
// sync server and the worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { address, audit, person, run, showSource, signIn } from './helpers';

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Results}',
  'Latency stays below forty milliseconds.',
  '',
  'The sentence for the proposal is here.',
  '\\end{document}',
  '',
].join('\n');

/** What has the keyboard: the element's name and the region it is in. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as (HTMLElement & { labels?: NodeList }) | null;
    const label = (el?.labels?.[0] as HTMLElement | undefined)?.firstChild?.textContent;
    if (!el || el === document.body) return { name: '(nothing has the keyboard)', region: '' };
    return {
      name: (el?.getAttribute('aria-label') ?? label ?? el?.textContent ?? '').trim(),
      region: el?.closest('section[aria-label]')?.getAttribute('aria-label') ?? '',
    };
  });

/** Press Tab until the thing with this name has the keyboard, and say how many presses it took. */
async function tabTo(page: Page, name: string | RegExp) {
  for (let i = 1; i <= 80; i++) {
    await page.keyboard.press('Tab');
    const now = (await focused(page)).name;
    if (typeof name === 'string' ? now === name : name.test(now)) return i;
  }
  throw new Error(`Tab never reached ${name}`);
}

test('a comment and a proposed change are started, sent and decided without losing the keyboard', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'keys-owner');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Keys ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator('.editor .visual .ProseMirror')).toContainText('Latency');

  /** Into the text, and a few characters of a line selected, with keys alone. */
  const select = async (line: number) => {
    await tabTo(page, 'main.tex, visual editor');
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < line; i++) await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowRight');
  };

  // A comment: the form takes the keyboard when it opens, and the button has it again when
  // the thread has been started.
  await select(1);
  await tabTo(page, 'Comment on the selected text');
  await page.keyboard.press('Enter');
  expect(await focused(page)).toMatchObject({ name: 'Comment', region: 'Comments' });
  await page.keyboard.type('Said with keys.');
  await tabTo(page, 'Start thread');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: /^Thread on/ })).toContainText('Said with keys.');
  expect(await focused(page)).toMatchObject({
    name: 'Comment on the selected text',
    region: 'Comments',
  });

  // A thread is resolved: it moves to the resolved ones, and the keyboard stays in the comments.
  await tabTo(page, 'Resolve');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('region', { name: 'Comments' }).getByText('Thread resolved.'),
  ).toBeVisible();
  expect((await focused(page)).region).toBe('Comments');

  // A proposed change, the same way.
  await select(3);
  await tabTo(page, 'Propose a change here');
  await page.keyboard.press('Enter');
  expect(await focused(page)).toMatchObject({
    name: 'Replace it with',
    region: 'Proposed changes',
  });
  await page.keyboard.type('Changed by keys');
  await tabTo(page, 'Propose');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: /Proposal to change/ })).toBeVisible();
  expect(await focused(page)).toMatchObject({
    name: 'Propose a change here',
    region: 'Proposed changes',
  });

  // It is accepted: the keyboard stays in the proposals, and the result is said in words.
  await tabTo(page, 'Accept');
  await page.keyboard.press('Enter');
  const proposals = page.getByRole('region', { name: 'Proposed changes' });
  await expect(proposals.getByText('Proposal accepted.')).toBeVisible();
  expect((await focused(page)).region).toBe('Proposed changes');
});

test('the window for an equation takes what is typed straight after it opens', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'keys-equation');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Equation ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator('.editor .visual .ProseMirror')).toContainText('Latency');

  await tabTo(page, 'main.tex, visual editor');
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Alt+=');
  const box = page.getByRole('dialog', { name: 'Insert an equation' });
  await expect(box).toBeVisible();
  await page.keyboard.type('x^2');
  await expect(box.getByLabel('LaTeX')).toHaveValue('x^2');
  await expect(box.getByLabel('In the line')).toBeChecked();
});

/** Sign in, import MAIN as a paper, and stay on the paper's page (or open its file). */
async function paper(browser: Parameters<typeof person>[0], who: string, open = false) {
  const { page, email } = await person(browser, who);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `${who} ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  if (open) {
    await page.getByRole('link', { name: 'main.tex' }).first().click();
    await expect(page.locator('.editor .visual .ProseMirror')).toContainText('Latency');
  }
  return page;
}

test("the text is three presses from the top of a file's page", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await paper(browser, 'keys-skip', true);
  await page.goto(page.url());
  await expect(page.locator('.editor .visual .ProseMirror[contenteditable=true]')).toBeVisible();
  await page.keyboard.press('Tab');
  expect((await focused(page)).name).toBe('Skip to the text');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect((await focused(page)).name).toBe('main.tex, visual editor');

  await showSource(page);
  await page.goto(page.url().split('#')[0]);
  await expect(page.locator('.editor .cm-content[contenteditable=true]')).toBeAttached();
  await page.keyboard.press('Tab');
  expect((await focused(page)).name).toBe('Skip to the text');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect((await focused(page)).name).toBe('LaTeX source of main.tex');
});

test("a paper's page: a section is reached from the top, and the result of a form has the keyboard", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await paper(browser, 'keys-page');
  await page.goto(page.url());
  // Loading a page is not a reason to take the keyboard.
  expect((await focused(page)).name).toBe('(nothing has the keyboard)');
  await audit(page, 'the paper page');

  await tabTo(page, 'Revisions');
  await page.keyboard.press('Enter');
  expect((await focused(page)).name).toBe('Revisions');
  await page.keyboard.press('Tab');
  expect((await focused(page)).name).toBe('Name for the paper as it is now');
  await page.keyboard.type('First');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');
  expect((await focused(page)).name).toBe('Saved as revision 1.');
  await page.keyboard.press('Tab');
  expect((await focused(page)).name).toBe('Name for the paper as it is now');
  await page.keyboard.type('Second');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Saved as revision 2.');
  expect((await focused(page)).name).toBe('Saved as revision 2.');

  await tabTo(page, 'Build the PDF for revision 1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Building the PDF');
  expect((await focused(page)).name).toMatch(/^Building the PDF/);

  await tabTo(page, 'Restore revision 1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Restored.');
  expect((await focused(page)).name).toMatch(/^Restored\./);

  // To the invitation from the top, and the result of sending it.
  const guest = address('keys-guest');
  await page.goto(page.url().split('?')[0]);
  const presses = (await tabTo(page, 'Invite someone')) + 1;
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect((await focused(page)).name).toBe('Their email address');
  console.log(`Tab presses from the top of the paper page to the email field: ${presses}`);
  expect(presses).toBeLessThanOrEqual(15);
  await page.keyboard.type(guest);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText(`Invitation sent to ${guest}.`);
  expect((await focused(page)).name).toBe(`Invitation sent to ${guest}.`);
});

test('a comment is changed, replied to and deleted, and a proposal changed, without losing the keyboard', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await paper(browser, 'keys-edit', true);
  const comments = page.getByRole('region', { name: 'Comments' });
  const select = async (line: number) => {
    await tabTo(page, 'main.tex, visual editor');
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < line; i++) await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowRight');
  };
  await select(1);
  await tabTo(page, 'Comment on the selected text');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Said with keys.');
  await tabTo(page, 'Start thread');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: /^Thread on/ })).toContainText('Said with keys.');

  // Change, then Save; Change, then Cancel.
  await tabTo(page, 'Change');
  await page.keyboard.press('Enter');
  expect((await focused(page)).name).toBe('Your comment');
  await page.keyboard.type(' More.');
  await tabTo(page, 'Save');
  await page.keyboard.press('Enter');
  await expect(comments.getByText('Comment changed.')).toBeVisible();
  await expect.poll(() => focused(page)).toMatchObject({ name: 'Change', region: 'Comments' });
  await page.keyboard.press('Enter');
  await tabTo(page, 'Cancel');
  await page.keyboard.press('Enter');
  await expect.poll(() => focused(page)).toMatchObject({ name: 'Change', region: 'Comments' });

  // Reply.
  await tabTo(page, /^Reply about/);
  await page.keyboard.type('A reply.');
  await tabTo(page, 'Reply');
  await page.keyboard.press('Enter');
  await expect(comments.getByText('Reply sent.')).toBeVisible();
  await expect(page.getByRole('article', { name: /^Thread on/ })).toContainText('A reply.');
  expect((await focused(page)).region).toBe('Comments');

  // Delete, kept and then done.
  await tabTo(page, 'Delete');
  await page.keyboard.press('Enter');
  expect((await focused(page)).name).toBe('Delete this comment?');
  await tabTo(page, 'Keep it');
  await page.keyboard.press('Enter');
  await expect.poll(() => focused(page)).toMatchObject({ name: 'Delete', region: 'Comments' });
  await page.keyboard.press('Enter');
  await tabTo(page, 'Delete it');
  await page.keyboard.press('Enter');
  await expect(comments.getByText('Comment deleted.')).toBeVisible();
  await expect.poll(async () => (await focused(page)).region).toBe('Comments');
  await audit(page, 'the file page');

  // A proposal is changed.
  await select(3);
  await tabTo(page, 'Propose a change here');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Changed by keys');
  await tabTo(page, 'Propose');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: /Proposal to change/ })).toBeVisible();
  await tabTo(page, 'Change the proposal');
  await page.keyboard.press('Enter');
  expect(await focused(page)).toMatchObject({
    name: 'Replace it with',
    region: 'Proposed changes',
  });
  await tabTo(page, 'Save the proposal');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('region', { name: 'Proposed changes' }).getByText('Proposal changed.'),
  ).toBeVisible();
  await expect
    .poll(() => focused(page))
    .toMatchObject({ name: 'Change the proposal', region: 'Proposed changes' });
});
