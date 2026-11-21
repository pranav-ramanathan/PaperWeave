// Where the keyboard is after a comment or a proposed change is started, sent and decided. The
// keyboard-only flow in a11y.spec stops at the comment; this carries on. Needs the services, the
// sync server and the worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { person, run, signIn } from './helpers';

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
async function tabTo(page: Page, name: string) {
  for (let i = 1; i <= 80; i++) {
    await page.keyboard.press('Tab');
    if ((await focused(page)).name === name) return;
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
