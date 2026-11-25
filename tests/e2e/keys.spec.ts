// Where the keyboard is after a comment or a proposed change is started, sent and decided. The
// keyboard-only flow in a11y.spec stops at the comment; this carries on. Needs the services, the
// sync server and the worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import {
  address,
  audit,
  emailedLink,
  person,
  run,
  selectWord,
  showSource,
  showVisual,
  dropOn,
  signIn,
  sourceText,
  typingSaved,
} from './helpers';

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

/**
 * Into the text, and the first seven characters of a line selected, with keys alone. Ctrl+Home
 * does nothing in the headless Chromium the tests run in (Home alone does), so the caret goes up
 * a line at a time and to the start of the line, until it is at the start of the text.
 */
async function selectLine(page: Page, line: number, words: string) {
  await tabTo(page, 'main.tex, visual editor');
  const editor = page.locator('.editor .visual .ProseMirror');
  /** The selected text, or null while the page's selection is not in the editor. */
  const selected = () =>
    editor.evaluate((el) => {
      const sel = document.getSelection();
      const inside = (n: Node | null) => !!n && el.contains(n);
      return sel && inside(sel.anchorNode) && inside(sel.focusNode) ? sel.toString() : null;
    });
  const atStart = () =>
    editor.evaluate((el) => {
      const sel = document.getSelection();
      // The first text a caret can be in: the preamble before it is a drawn block.
      const first = document
        .createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) =>
            n.parentElement?.closest('[contenteditable=false]')
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT,
        })
        .nextNode();
      return !!sel && sel.isCollapsed && sel.anchorNode === first && sel.anchorOffset === 0;
    });
  await expect.poll(selected).not.toBeNull();
  for (let i = 0; i < 10 && !(await atStart()); i++) {
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
  }
  await expect.poll(atStart).toBe(true);
  for (let i = 0; i < line; i++) await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(selected).toBe(words);
}

/**
 * Where the caret is in the editor: at the start of the first text a caret can be in, at the end
 * of the last one, or neither. The preamble and \\end{document} around the text are drawn blocks.
 */
const caretAt = (page: Page) =>
  page.locator('.editor .visual .ProseMirror').evaluate((el) => {
    const sel = document.getSelection();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest('[contenteditable=false]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    let first: Node | null = null;
    let last: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      first ??= n;
      last = n;
    }
    // No caret in the editor yet: it takes the keyboard first, and puts its caret in the text a
    // frame later (onFocus in visual.ts). That is not "elsewhere in the text".
    if (!sel?.anchorNode || !el.contains(sel.anchorNode)) return 'none';
    if (!sel.isCollapsed) return 'selection';
    if (sel.anchorNode === first && sel.anchorOffset === 0) return 'start';
    if (sel.anchorNode === last && sel.anchorOffset === (last?.textContent?.length ?? -1))
      return 'end';
    return 'elsewhere';
  });

/** The caret to the start of the text with ArrowUp and Home, as selectLine does. */
async function caretToStart(page: Page) {
  for (let i = 0; i < 10 && (await caretAt(page)) !== 'start'; i++) {
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
  }
  await expect.poll(() => caretAt(page)).toBe('start');
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

  const select = (line: number, words: string) => selectLine(page, line, words);

  // A comment: the form takes the keyboard when it opens, and the button has it again when
  // the thread has been started.
  await select(1, 'Latency');
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
  await select(2, 'The sen');
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

test('a reviewer selects words in the visual view with keys alone, comments on them and proposes a change; nothing they type changes the paper', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await paper(browser, 'keys-rev-owner');
  const reviewer = await person(browser, 'keys-rev');
  await owner.getByLabel('Their email address').fill(reviewer.email);
  await owner.getByLabel('Their role').selectOption('reviewer');
  await owner.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.getByRole('status')).toContainText(reviewer.email);
  await reviewer.page.goto(await emailedLink(reviewer.email, '/invitations/'));
  await signIn(reviewer.page, reviewer.email);
  await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  const page = reviewer.page;

  const editor = page.locator('.editor .visual .ProseMirror');
  await expect(page.getByText('Read only. You can read along but not edit.')).toBeVisible();
  await expect(editor).toHaveAttribute('aria-readonly', 'true');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(editor).toContainText('Latency stays below forty milliseconds.');
  await expect(page.getByRole('button', { name: 'Emphasise' })).toHaveCount(0);
  await audit(page, 'the visual view for a reviewer');

  // Words selected with keys alone.
  await selectLine(page, 1, 'Latency');

  // Nothing typed, deleted, pasted, dropped or composed changes the paper.
  await page.keyboard.type('zzz');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Enter');
  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'PASTED');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await dropOn(editor, { text: 'DROPPED' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '日本' });
  await expect(page.locator('.editor .toolbar .note')).toHaveText(
    'You can read this paper but not edit it. Nothing was changed.',
  );
  for (const gone of ['zzz', 'PASTED', 'DROPPED', '日本', 'に'])
    await expect(editor).not.toContainText(gone);
  await expect(editor).toContainText('Latency stays below forty milliseconds.');

  // A comment on the words, started from the keyboard.
  await selectLine(page, 1, 'Latency');
  await tabTo(page, 'Comment on the selected text');
  await page.keyboard.press('Enter');
  await page.keyboard.type('From the keyboard.');
  await tabTo(page, 'Start thread');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: /^Thread on/ })).toContainText(
    'From the keyboard.',
  );
  await expect(editor.locator('.thread-mark').first()).toHaveText('Latency');

  // A proposed change to them.
  await selectLine(page, 1, 'Latency');
  await tabTo(page, 'Propose a change here');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Replace it with')).toHaveValue('Latency');
  await page.keyboard.type('Delay');
  await tabTo(page, 'Propose');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: /Proposal to change/ })).toBeVisible();
  await audit(page, 'the visual view for a reviewer with a comment and a proposal');

  // The owner's copy is exactly what it was.
  await owner.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(owner);
  // The source's text has no line breaks (they are drawn, not text): compare without whitespace.
  await expect
    .poll(async () => (await sourceText(owner)).replace(/\s/g, ''))
    .toBe(MAIN.replace(/\s/g, ''));
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
  await caretToStart(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Alt+=');
  const box = page.getByRole('dialog', { name: 'Insert an equation' });
  await expect(box).toBeVisible();
  await page.keyboard.type('x^2');
  await expect(box.getByLabel('LaTeX')).toHaveValue('x^2');
  await expect(box.getByLabel('In the line')).toBeChecked();
});

/** Sign in, import MAIN as a paper, and stay on the paper's page (or open its file). */
async function paper(
  browser: Parameters<typeof person>[0],
  who: string,
  open = false,
  main = MAIN,
  extra: { path: string; bytes: Buffer }[] = [],
) {
  const { page, email } = await person(browser, who);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `${who} ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }, ...extra]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  if (open) {
    await page.getByRole('link', { name: 'main.tex' }).first().click();
    await expect(page.locator('.editor .visual .ProseMirror[contenteditable=true]')).toBeVisible();
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

  await tabTo(page, 'Build PDF for revision 1');
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
  const select = (line: number, words: string) => selectLine(page, line, words);
  await select(1, 'Latency');
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
  await select(2, 'The sen');
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

test('the toolbar is one Tab stop, and the arrow keys move along it', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await paper(browser, 'keys-toolbar', true);
  const bar = page.getByRole('toolbar', { name: 'Editor tools' });
  await expect(bar.getByRole('button')).toHaveCount(16);
  await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);

  await tabTo(page, 'Visual');
  expect(await tabTo(page, 'main.tex, visual editor')).toBe(1);
  const name = async () => (await focused(page)).name;
  const press = async (key: string) => {
    await page.keyboard.press(key);
    return name();
  };
  expect(await press('Shift+Tab')).toBe('Visual');
  expect(await press('ArrowRight')).toBe('Source');
  expect(await press('ArrowRight')).toBe('Emphasise');
  expect(await press('ArrowRight')).toBe('Bold');
  expect(await press('ArrowLeft')).toBe('Emphasise');
  expect(await press('End')).toBe('Show in PDF');
  expect(await press('ArrowRight')).toBe('Visual');
  expect(await press('ArrowLeft')).toBe('Show in PDF');
  expect(await press('ArrowLeft')).toBe('Numbered list');
  expect(await press('Home')).toBe('Visual');

  // The stop is the button that was left.
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  expect(await name()).toBe('Equation');
  expect(await press('Tab')).toBe('main.tex, visual editor');
  expect(await press('Shift+Tab')).toBe('Equation');

  await page.keyboard.press('Enter');
  const insert = page.getByRole('dialog', { name: 'Insert an equation' });
  await expect(insert).toBeVisible();
  await page.keyboard.type('x');
  await expect(insert.getByLabel('LaTeX')).toHaveValue('x');
  await page.keyboard.press('Escape');
  await expect.poll(name).toBe('main.tex, visual editor');

  // The source view has four buttons (Find and replace is the new one), and the stop survives the Edit group going.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect.poll(name).toBe('LaTeX source of main.tex');
  expect(await press('Shift+Tab')).toBe('Source');
  expect(await press('End')).toBe('Show in PDF');
  expect(await press('ArrowRight')).toBe('Visual');
  await expect(bar.getByRole('button')).toHaveCount(4);
  await audit(page, 'the file page with its toolbar');

  await showVisual(page);
  await page.goto(page.url().split('#')[0]);
  await expect(page.locator('.editor .visual .ProseMirror[contenteditable=true]')).toBeVisible();
  const top = await tabTo(page, 'main.tex, visual editor');
  console.log(`Tab presses from the top of the file page to the text, skip link not used: ${top}`);
});

test("another page's refusal has the keyboard", async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await paper(
    browser,
    'keys-err',
    false,
    MAIN.replace('\\section{Results}', '\\section{Results}\\label{sec:results}'),
    [{ path: 'data.csv', bytes: Buffer.from('x,y\n1,2\n2,4\n3,6\n') }],
  );
  const id = /\/projects\/([^/?#]+)/.exec(page.url())![1];
  const idOf = async (link: string) =>
    /\/([^/?#]+)$/.exec((await page.locator(link).first().getAttribute('href'))!)![1];
  const mainId = await idOf(`a[href^="/projects/${id}/files/"]`);
  const csvId = await idOf(`a[href^="/projects/${id}/data/"]`);

  const guest = address('keys-err-guest');
  await page.getByLabel('Their email address').fill(guest);
  await page.getByLabel('Their email address').press('Enter');
  await expect(page.getByRole('status')).toHaveText(`Invitation sent to ${guest}.`);
  const invite = new URL(await emailedLink(guest, '/invitations/')).pathname;

  const taken = async (who: Page, path: string) => {
    await who.goto(`${path}${path.includes('?') ? '&' : '?'}error=Tried`);
    await expect(who.getByRole('alert').filter({ hasText: 'Tried' }), path).toBeVisible();
    await expect.poll(() => focused(who), { message: path }).toMatchObject({ name: 'Tried' });
  };
  for (const path of [
    `/projects/${id}/submit`,
    `/projects/${id}/charts/new`,
    `/projects/${id}/data/${csvId}`,
    `/projects/${id}/files/${mainId}/rename?to=paper.tex`,
    `/projects/${id}/labels/rename?from=sec:results&to=sec:res`,
  ])
    await taken(page, path);

  // The invitation has two lines: for the person it is for, and for someone else.
  for (const who of [guest, address('keys-err-other')]) {
    const other = (await person(browser, who.split('@')[0].replace(`-${run}`, ''))).page;
    await other.goto('/sign-in');
    await signIn(other, who);
    await taken(other, invite);
  }
});

test('a formula is opened for editing with the keyboard', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await paper(
    browser,
    'keys-formula',
    true,
    [
      '\\documentclass{article}',
      '\\begin{document}',
      'Let $T$ be the text.',
      '',
      '\\begin{equation}',
      'a = b',
      '\\end{equation}',
      '\\end{document}',
      '',
    ].join('\n'),
  );
  await tabTo(page, 'main.tex, visual editor');
  await caretToStart(page);
  // From the top, Right goes over the preamble and then the words; it stops on the formula.
  const inline = page.locator('.editor .visual .ProseMirror-selectednode.pw-math:not(.pw-block)');
  let rights = 0;
  while (rights < 15 && !(await inline.count())) {
    await page.keyboard.press('ArrowRight');
    rights++;
  }
  await expect(inline).toHaveCount(1);
  console.log(`ArrowRight presses from the top to the inline formula: ${rights}`);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Edit formula' });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel('LaTeX');
  await expect(field).toHaveValue('$T$');
  await expect(field).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('$T_1$');
  await tabTo(page, 'Apply');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await focused(page)).name).toBe('main.tex, visual editor');
  // The edit has reached the text: the formula is drawn again, from what was typed.
  await expect(page.locator('.editor .visual .pw-math[title="$T_1$"]')).toHaveCount(1);

  // A display formula: down from the paragraph above selects it, and Enter opens it. Just after
  // the editor takes the keyboard back, its caret is put back for a moment, and a key pressed in
  // that moment can be lost. So each press is given time to show its effect, and is made again if
  // it has none; the check is not made between the key and the editor drawing what it did.
  await page.keyboard.press('ArrowRight');
  let downs = 0;
  const selected = page.locator('.editor .visual .ProseMirror-selectednode.pw-math');
  while (downs < 8 && !(await selected.count())) {
    await page.keyboard.press('ArrowDown');
    downs++;
    await selected.waitFor({ timeout: 1000 }).catch(() => undefined);
  }
  await expect(selected).toHaveCount(1);
  console.log(`ArrowDown presses from the paragraph to the display formula: ${downs}`);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue(/^\\begin\{equation\}/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await showSource(page);
  expect(await sourceText(page)).toContain('Let $T_1$ be');
});

test('Ctrl+Home and Ctrl+End go to the start and the end of the text, with Shift they select', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await paper(browser, 'keys-edges', true);
  const editor = page.locator('.editor .visual .ProseMirror');
  const selected = () => page.evaluate(() => document.getSelection()?.toString() ?? '');
  // Into the text, away from both edges. Just after the editor takes the keyboard it puts its
  // own caret back for a moment (ProseMirror, within 20 ms), so the move is made again until it
  // has stuck; no person types that fast.
  const middle = async () => {
    // Keys pressed before the editor has put its caret in the text go nowhere.
    await expect.poll(() => caretAt(page)).not.toBe('none');
    for (let i = 0; i < 5 && (await caretAt(page)) !== 'elsewhere'; i++) {
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
    }
    await expect.poll(() => caretAt(page)).toBe('elsewhere');
  };
  await tabTo(page, 'main.tex, visual editor');
  await expect(editor).toBeFocused();
  await middle();
  await page.keyboard.press('ControlOrMeta+Home');
  expect(await caretAt(page)).toBe('start');
  await page.keyboard.press('ControlOrMeta+End');
  expect(await caretAt(page)).toBe('end');

  // Shift extends from the caret to the edge, either way.
  await page.keyboard.press('ControlOrMeta+Home');
  await middle();
  await page.keyboard.press('Shift+ControlOrMeta+Home');
  expect(await selected()).toMatch(/^Results/);
  await page.keyboard.press('ControlOrMeta+Home');
  await middle();
  await page.keyboard.press('Shift+ControlOrMeta+End');
  expect((await selected()).trimEnd()).toMatch(/proposal is here\.$/);
});

test('Compile now keeps the keyboard while the PDF is built', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await paper(browser, 'keys-compile', true);
  const build = page.locator('.build');
  const status = build.getByRole('status');
  await expect(status).toHaveText('The PDF is up to date.', { timeout: 60_000 });
  const builds: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/builds')) builds.push(r.url());
  });

  // Behind the text, and not built by itself: the button is the way to the PDF.
  await build.getByRole('checkbox', { name: 'Compile automatically' }).uncheck();
  await showSource(page);
  await page.locator('.editor .cm-content').click();
  await page.keyboard.type('x');
  await expect(status).toHaveText('The PDF is behind the text.', { timeout: 30_000 });

  await tabTo(page, 'Compile now');
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('Compiling…');
  expect((await focused(page)).name).toBe('Compile now');
  // Pressed again while it builds, by Enter and by Space: nothing is sent.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect((await focused(page)).name).toBe('Compile now');
  await expect(status).toHaveText('The PDF is up to date.', { timeout: 60_000 });
  expect((await focused(page)).name).toBe('Compile now');
  expect(builds).toHaveLength(1);
});

test('Attach to the same words again keeps the keyboard and says what happened', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await paper(browser, 'keys-attach', true);
  const comments = page.getByRole('region', { name: 'Comments' });

  await selectLine(page, 1, 'Latency');
  await tabTo(page, 'Comment on the selected text');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Where did this go?');
  await tabTo(page, 'Start thread');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: /^Thread on/ })).toContainText(
    'Where did this go?',
  );

  // The words are deleted, so the thread is detached, and then written again by hand (not
  // undone), in a comment line where they occur once: only the button can attach it.
  await showSource(page);
  await selectWord(page, '.editor .cm-content', 'Latency');
  await page.keyboard.press('Backspace');
  await typingSaved(page);
  await expect(comments).toContainText('This text has been deleted.', { timeout: 15_000 });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('% Latency');
  await typingSaved(page);

  await tabTo(page, 'Attach to the same words again');
  await page.keyboard.press('Enter');
  await expect(comments.locator('[aria-live=polite]')).toHaveText('The words were found again.');
  await expect(comments).not.toContainText('This text has been deleted.');
  // The button is gone: the keyboard is on something in the comments, not on the page.
  const now = await focused(page);
  expect(now.name).not.toBe('(nothing has the keyboard)');
  expect(now.region).toBe('Comments');
});

test('removing someone says so and keeps the keyboard', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await paper(browser, 'keys-remove');
  const guest = await person(browser, 'keys-remove-guest');
  await page.getByLabel('Their email address').fill(guest.email);
  await page.getByLabel('Their email address').press('Enter');
  await expect(page.getByRole('status')).toHaveText(`Invitation sent to ${guest.email}.`);
  await guest.page.goto(await emailedLink(guest.email, '/invitations/'));
  await signIn(guest.page, guest.email);
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText('You are a')).toBeVisible();

  // A role is changed first, so the address holds ?saved=1 when the guest is removed.
  await page.goto(page.url().split('?')[0]);
  await page.getByLabel(`Role of ${guest.email}`).selectOption('editor');
  await tabTo(page, 'Change');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Role changed.');
  expect(page.url()).toContain('saved=1');

  await tabTo(page, `Remove ${guest.email}`);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText(`Removed ${guest.email} from this paper.`);
  expect(page.url()).not.toContain('saved=1');
  expect((await focused(page)).name).toBe(`Removed ${guest.email} from this paper.`);
  await expect(page.getByRole('rowheader', { name: guest.email })).toHaveCount(0);
});

test('leaving a paper says so on the list of papers and keeps the keyboard', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await paper(browser, 'keys-leave');
  const guest = await person(browser, 'keys-leave-guest');
  await page.getByLabel('Their email address').fill(guest.email);
  await page.getByLabel('Their email address').press('Enter');
  await expect(page.getByRole('status')).toHaveText(`Invitation sent to ${guest.email}.`);
  await guest.page.goto(await emailedLink(guest.email, '/invitations/'));
  await signIn(guest.page, guest.email);
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText('You are a')).toBeVisible();
  const name = (await guest.page.getByRole('heading', { level: 1 }).first().innerText()).trim();

  await tabTo(guest.page, 'Leave this paper');
  await guest.page.keyboard.press('Enter');
  await expect(guest.page).toHaveURL(/\/projects\?/);
  await expect(guest.page.getByRole('status')).toHaveText(`You left ${name}.`);
  expect((await focused(guest.page)).name).toBe(`You left ${name}.`);
});

test('removing a chart says so and keeps the keyboard', async ({ browser }) => {
  test.setTimeout(180_000);
  const csv = 'day,latency (ms)\n2024-03-01,9\n2024-03-03,38\n2024-03-04,41\n';
  const page = await paper(browser, 'keys-chart', false, MAIN, [
    { path: 'data/latency.csv', bytes: Buffer.from(csv) },
  ]);
  const data = page.getByRole('listitem').filter({ hasText: 'data/latency.csv:' });
  await data.getByRole('link', { name: 'Describe it' }).click();
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await data.getByRole('link', { name: 'New chart from data/latency.csv' }).click();
  await page.getByLabel('Name', { exact: true }).fill('latency');
  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('line');
  await page.getByRole('combobox', { name: 'Along the bottom', exact: true }).selectOption('day');
  await page.getByRole('button', { name: 'Draw the chart' }).click();
  await expect(
    page.getByRole('img', { name: 'Line chart of latency (ms) against day.' }),
  ).toBeVisible({ timeout: 30_000 });

  await tabTo(page, 'Remove this chart');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Removed the chart latency.');
  expect((await focused(page)).name).toBe('Removed the chart latency.');
  await expect(page.getByRole('link', { name: 'latency', exact: true })).toHaveCount(0);
});

test('removing two checks of one citation says so each time and keeps the keyboard', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const main = MAIN.replace('Latency stays', 'Latency~\\cite{knuth1984} stays').replace(
    '\\end{document}',
    '\\bibliography{refs}\n\\end{document}',
  );
  const bib = '@misc{knuth1984, title = {Literate Programming}, year = {1984}}\n';
  const page = await paper(browser, 'keys-evidence', false, main, [
    { path: 'refs.bib', bytes: Buffer.from(bib) },
  ]);
  const row = page.getByRole('row', { name: /^knuth1984/ });
  for (const claim of ['A first claim', 'A second claim']) {
    await row.getByText('Record a check').click();
    await row.getByLabel('The claim that cites knuth1984').fill(claim);
    await row.getByRole('button', { name: 'Record' }).click();
    await expect(page.getByRole('status')).toContainText('Recorded an evidence check');
    await expect(row).toContainText(claim);
  }

  const line = 'Removed a check of knuth1984.';
  for (const left of [1, 0]) {
    await tabTo(page, 'Remove this check of knuth1984');
    await page.keyboard.press('Enter');
    await expect(row.getByRole('button', { name: 'Remove this check of knuth1984' })).toHaveCount(
      left,
    );
    await expect(page.getByRole('status')).toHaveText(line);
    expect((await focused(page)).name).toBe(line);
  }
});

test('taking a spelling finding keeps the keyboard in the panel and says what was done', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'The sentense is short. Our system, Weavely, is fast.',
    '',
    'It was recieved.',
    '\\end{document}',
    '',
  ].join('\n');
  const page = await paper(browser, 'keys-grammar', false, main);
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  const panel = page.getByRole('region', { name: 'Spelling and grammar' });
  const article = (name: string) => panel.getByRole('article', { name });
  await expect(article('Spelling: “sentense”')).toBeVisible({ timeout: 30_000 });
  await expect(article('Spelling: “recieved”')).toBeVisible();

  // Change: the next finding's first button has the keyboard, and the note says what was done.
  await article('Spelling: “sentense”')
    .getByRole('button', { name: /^Change to/ })
    .first()
    .focus();
  await page.keyboard.press('Enter');
  await expect(panel).toContainText('Changed “sentense” to “sentence”.');
  await expect(article('Spelling: “sentense”')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest('article')?.getAttribute('aria-label')),
    )
    .toMatch(/^Spelling: “(Weavely|recieved)”$/);
  expect((await focused(page)).region).toBe('Spelling and grammar');

  // A word of the paper's own.
  await article('Spelling: “Weavely”')
    .getByRole('button', { name: 'It is a word of this paper' })
    .focus();
  await page.keyboard.press('Enter');
  await expect(article('Spelling: “Weavely”')).toHaveCount(0);
  expect((await focused(page)).region).toBe('Spelling and grammar');

  // The last one: the heading has the keyboard.
  await article('Spelling: “recieved”')
    .getByRole('button', { name: /^Change to/ })
    .first()
    .focus();
  await page.keyboard.press('Enter');
  await expect(panel).toContainText('Changed “recieved” to');
  await expect(panel.getByRole('article')).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: 'Spelling and grammar' })).toBeFocused();
});

test('a reviewer proposing a spelling change keeps the keyboard in the panel', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'The sentense is short and it was recieved.',
    '\\end{document}',
    '',
  ].join('\n');
  const owner = await paper(browser, 'keys-gprop-owner', false, main);
  const reviewer = await person(browser, 'keys-gprop-reviewer');
  await owner.getByLabel('Their email address').fill(reviewer.email);
  await owner.getByLabel('Their role').selectOption('reviewer');
  await owner.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.getByRole('status')).toContainText(reviewer.email);
  await reviewer.page.goto(await emailedLink(reviewer.email, '/invitations/'));
  await signIn(reviewer.page, reviewer.email);
  await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  const page = reviewer.page;
  const panel = page.getByRole('region', { name: 'Spelling and grammar' });
  await expect(panel.getByRole('article', { name: 'Spelling: “sentense”' })).toBeVisible({
    timeout: 30_000,
  });
  await panel
    .getByRole('button', { name: /^Propose “/ })
    .first()
    .focus();
  await page.keyboard.press('Enter');
  await expect(panel).toContainText(/Proposed changing “(sentense|recieved)”/);
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest('article')?.getAttribute('aria-label')),
    )
    .toMatch(/^Spelling: “(sentense|recieved)”$/);
  expect((await focused(page)).region).toBe('Spelling and grammar');
});

test('a reply sent with Enter on a Mention checkbox keeps the keyboard in the comments', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await paper(browser, 'keys-mention', true);
  const second = await person(browser, 'keys-mention-second');
  // A second member, so that the reply form lists someone to mention.
  const paperUrl = page.url().replace(/\/files\/.*$/, '');
  await page.goto(paperUrl);
  await page.getByLabel('Their email address').fill(second.email);
  await page.getByLabel('Their role').selectOption('editor');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText(second.email);
  await second.page.goto(await emailedLink(second.email, '/invitations/'));
  await signIn(second.page, second.email);
  await second.page.getByRole('button', { name: 'Join this paper' }).click();
  // Wait for the join to land. The file page lists the people to mention as they are when it is
  // drawn: opened before the second member is on the paper, it has no one to mention, and Tab
  // from the reply goes to its button.
  await expect(second.page.getByText('You are an editor')).toBeVisible();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator('.editor .visual .ProseMirror[contenteditable=true]')).toBeVisible();

  const comments = page.getByRole('region', { name: 'Comments' });
  await selectLine(page, 1, 'Latency');
  await tabTo(page, 'Comment on the selected text');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Said with keys.');
  await tabTo(page, 'Start thread');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: /^Thread on/ })).toContainText('Said with keys.');
  await tabTo(page, /^Reply about/);
  await page.keyboard.type('A reply with a mention.');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).type)).toBe(
    'checkbox',
  );
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await expect(comments.getByText('Reply sent.')).toBeVisible();
  // The list of people has closed, with the checkbox the keyboard was on.
  await expect(comments.getByRole('group', { name: 'Mention' })).toHaveCount(0);
  await expect(page.getByRole('article', { name: /^Thread on/ })).toContainText(
    'A reply with a mention.',
  );
  expect((await focused(page)).region).toBe('Comments');
});
