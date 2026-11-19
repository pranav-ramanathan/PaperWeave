// The visual editor in the app, through the real sync server: visual typing, a visual edit racing
// a source edit, a structural edit made by the server, and switching views with the selection.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { clickAfter, dropOn, emailedLink, person, run, showSource, signIn } from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');
const VISUAL = '.editor .visual .ProseMirror';
const SOURCE = '.editor .cm-content';
const status = (page: Page) =>
  page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
const view = (page: Page, name: string) =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name });
// A one-pixel picture, as base64.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const selected = (page: Page) => page.evaluate(() => getSelection()!.toString());

/** Double-click a word in an editor, as a person would to select it. */
async function pick(page: Page, within: string, word: string) {
  const at = await page.evaluate(
    ([sel, w]) => {
      const walker = document.createTreeWalker(document.querySelector(sel)!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(w);
        if (i < 0) continue;
        n.parentElement!.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + w.length);
        const r = range.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    },
    [within, word] as const,
  );
  if (!at) throw new Error(`"${word}" is not shown in ${within}`);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => selected(page)).toBe(word);
}
/** Type just after a word. */
async function typeAfter(page: Page, within: string, word: string, text: string) {
  await pick(page, within, word);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type(text);
}

test('visual edits reach the source through the server, byte for byte', async ({ browser }) => {
  const owner = await person(browser, 'vis-owner');
  const editor = await person(browser, 'vis-editor');
  const reviewer = await person(browser, 'vis-reviewer');
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Visual ${run}.zip`);
  writeFileSync(zip, await writeZip(files));

  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(owner.page.getByRole('heading', { name: `Visual ${run}` })).toBeVisible();
  for (const [who, role] of [
    [editor, 'editor'],
    [reviewer, 'reviewer'],
  ] as const) {
    await owner.page.getByLabel('Their email address').fill(who.email);
    await owner.page.getByLabel('Their role').selectOption(role);
    await owner.page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(owner.page.getByRole('status')).toContainText(who.email);
    await who.page.goto(await emailedLink(who.email, '/invitations/'));
    await signIn(who.page, who.email);
    await who.page.getByRole('button', { name: 'Join this paper' }).click();
    await expect(
      who.page.getByText(`You are ${role === 'editor' ? 'an' : 'a'} ${role}`),
    ).toBeVisible();
  }

  // A .tex file opens in the visual view. The owner stays there; the editor works in the source.
  await owner.page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await expect(view(owner.page, 'Visual')).toHaveAttribute('aria-pressed', 'true');
  await expect(
    owner.page.locator(VISUAL).getByRole('heading', { name: 'Introduction' }),
  ).toBeVisible();
  await expect(status(owner.page)).toHaveText('All edits saved.');
  await editor.page.goto(owner.page.url());
  await showSource(editor.page);
  await expect(status(editor.page)).toHaveText('All edits saved.');

  // Typing in the visual view arrives in the other person's source.
  await typeAfter(owner.page, VISUAL, 'opposite', ' and simpler');
  await expect(editor.page.locator(SOURCE)).toContainText(
    'takes the opposite and simpler approach',
  );

  // The owner goes offline and edits visually while the editor edits the same sentence in source.
  await owner.page.context().setOffline(true);
  await expect(status(owner.page)).toContainText('Offline.');
  await typeAfter(owner.page, VISUAL, 'splice', ' (visual)');
  await typeAfter(editor.page, SOURCE, 'characters', ' (source)');
  await expect(status(editor.page)).toHaveText('All edits saved.');
  await owner.page.context().setOffline(false);
  await expect(status(owner.page)).toHaveText('All edits saved.', { timeout: 30_000 });
  const both = 'a splice (visual) of a few characters (source), ';
  await expect(owner.page.locator(VISUAL)).toContainText(both);
  await expect(editor.page.locator(SOURCE)).toContainText(both);

  // Emphasis is a structural edit: the server checks and makes it, and it can be undone.
  await pick(owner.page, VISUAL, 'Reviewers');
  await owner.page.getByRole('button', { name: 'Emphasise' }).click();
  await expect(editor.page.locator(SOURCE)).toContainText('\\emph{Reviewers} then see');
  await expect(owner.page.locator(`${VISUAL} em`, { hasText: 'Reviewers' })).toBeVisible();
  await owner.page.getByRole('button', { name: 'Undo' }).click();
  await expect(editor.page.locator(SOURCE)).not.toContainText('\\emph{Reviewers}');
  await expect(editor.page.locator(SOURCE)).toContainText(both);

  // Switching views carries the selection across, both ways.
  await pick(owner.page, VISUAL, 'organised');
  await view(owner.page, 'Source').click();
  await expect(owner.page.locator(SOURCE)).toBeVisible();
  await expect(owner.page.locator(VISUAL)).toBeHidden();
  await expect.poll(() => selected(owner.page)).toBe('organised');
  await pick(owner.page, SOURCE, 'measured');
  await view(owner.page, 'Visual').click();
  await expect(owner.page.locator(VISUAL)).toBeVisible();
  await expect.poll(() => selected(owner.page)).toBe('measured');

  // LaTeX the visual view does not edit is shown as it is, with a way to its source.
  await owner.page.getByRole('link', { name: 'main.tex' }).click();
  // The file that was open has such buttons too: wait for the one that was asked for.
  await expect(owner.page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  await owner.page.locator(VISUAL).getByRole('button', { name: 'Edit in source' }).first().click();
  await expect(view(owner.page, 'Source')).toHaveAttribute('aria-pressed', 'true');
  await expect(owner.page.locator(SOURCE)).toBeFocused();

  // A reviewer can read the visual view but not change it.
  await reviewer.page.goto(editor.page.url());
  await expect(status(reviewer.page)).toHaveText('Read only. You can read along but not edit.');
  await expect(reviewer.page.locator(VISUAL)).toContainText(both);
  await expect(reviewer.page.locator(VISUAL)).toHaveAttribute('contenteditable', 'false');
  await expect(reviewer.page.getByRole('button', { name: 'Emphasise' })).toHaveCount(0);

  // The download: the edited file differs by exactly what was typed, every other file by nothing.
  await owner.page.getByRole('link', { name: 'Paper overview' }).click();
  const [download] = await Promise.all([
    owner.page.waitForEvent('download'),
    owner.page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  const back = await readZip(readFileSync(await download.path()));
  const bytes = (path: string) => Buffer.from(back.entries.find((e) => e.path === path)!.bytes);
  const original = files.find((f) => f.path === 'sections/intro.tex')!.bytes.toString();
  expect(bytes('sections/intro.tex').toString()).toBe(
    original
      .replace('opposite', 'opposite and simpler')
      .replace('a splice', 'a splice (visual)')
      .replace('characters', 'characters (source)'),
  );
  for (const f of files)
    if (f.path !== 'sections/intro.tex') expect(bytes(f.path).equals(f.bytes), f.path).toBe(true);
});

test('something pasted into the visual view goes in as its words', async ({ browser }) => {
  const { page, email } = await person(browser, 'vis-paste');
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'Latency stays below forty milliseconds for most edits.',
    '',
    'Nothing else is claimed here.',
    '\\end{document}',
    '',
  ].join('\n');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Paste ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(status(page)).toHaveText('All edits saved.');

  // A paste as the browser makes it: the clipboard's several forms, and any files.
  const paste = (clip: { text: string; html?: string; png?: boolean }) =>
    page.locator(VISUAL).evaluate(
      (el, c) => {
        const data = new DataTransfer();
        if (c.html) data.setData('text/html', c.html);
        if (c.text) data.setData('text/plain', c.text);
        if (c.png) {
          const bytes = Uint8Array.from(atob(c.png), (ch) => ch.charCodeAt(0));
          data.items.add(new File([bytes], 'p.png', { type: 'image/png' }));
        }
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      },
      { ...clip, png: clip.png ? PNG : '' },
    );
  const note = page.locator('.editor .toolbar .note');
  const source = async () => {
    await showSource(page);
    const text = (await page.locator(`${SOURCE} .cm-line`).allInnerTexts())
      .join('\n')
      .replace(/\n{2,}/g, '\n\n');
    await view(page, 'Visual').click();
    await expect(page.locator(VISUAL)).toBeVisible();
    return text;
  };

  // Paragraphs go in as paragraphs.
  await clickAfter(page, VISUAL, 'claimed here.');
  await paste({ text: 'First para.\n\nSecond para.' });
  await expect(page.locator(VISUAL)).toContainText('Second para.');
  await expect(status(page)).toHaveText('All edits saved.');
  await expect(page.locator(VISUAL).locator('p', { hasText: 'First para.' })).toHaveCount(1);
  await expect(page.locator(VISUAL).locator('p', { hasText: /^Second para\.$/ })).toHaveCount(1);
  await expect.poll(source).toContain('First para.\n\nSecond para.');

  // What the clipboard says about lists and tables is not LaTeX: only the words go in.
  await clickAfter(page, VISUAL, 'Second para.');
  await paste({ html: '<ul><li>a</li><li>b</li></ul>', text: 'a\nb' });
  await expect.poll(source).toContain('Second para.a b');
  await paste({
    html: '<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>',
    text: '1\t2\n3\t4',
  });
  await expect.poll(source).toContain('Second para.a b1 2 3 4');

  // A picture cannot go into the text: that is said, and nothing changes.
  const before = await source();
  await paste({ text: '', png: true });
  await expect(note).toContainText('A picture or file cannot be pasted into the text.');
  expect(await source()).toBe(before);

  // Characters LaTeX reads are escaped, as when typing, in one paragraph or several.
  await paste({ text: '50% of R&D cost $5 for item_1 #2' });
  await expect.poll(source).toContain('50\\% of R\\&D cost \\$5 for item\\_1 \\#2');
  await paste({ text: '50% & more\n\nand $x$ too' });
  await expect.poll(source).toContain('\\#250\\% \\& more\n\nand \\$x\\$ too');
});

test('something dropped on the visual view goes in as its words, and the source view takes no file', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'vis-drop');
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'Latency stays below forty milliseconds for most edits.',
    '',
    'Nothing else is claimed here.',
    '\\end{document}',
    '',
  ].join('\n');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Drop ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(status(page)).toHaveText('All edits saved.');

  const png = { name: 'p.png', type: 'image/png', base64: PNG };
  const bib = {
    name: 'refs.bib',
    type: 'text/plain',
    base64: Buffer.from('@article{key,\n  title={T},\n  year={2020}\n}\n').toString('base64'),
  };
  const note = page.locator('.editor .toolbar .note');
  const paragraph = page.locator(VISUAL).locator('p', { hasText: 'Nothing else is claimed' });
  const source = async () => {
    await showSource(page);
    const text = (await page.locator(`${SOURCE} .cm-line`).allInnerTexts())
      .join('\n')
      .replace(/\n{2,}/g, '\n\n');
    await view(page, 'Visual').click();
    await expect(page.locator(VISUAL)).toBeVisible();
    return text;
  };

  // A picture is not opened in the tab, and cannot go into the text: that is said.
  const before = await source();
  const dropped = await dropOn(paragraph, { file: png });
  expect(dropped.over, 'the dragover of a picture was cancelled').toBe(true);
  expect(dropped.drop, 'the drop of a picture was cancelled').toBe(true);
  await expect(note).toContainText('A picture or file cannot be dropped into the text.');
  expect(await source()).toBe(before);

  // Several paragraphs go in as paragraphs, where they were dropped.
  await dropOn(paragraph, { text: 'First para.\n\nSecond para.' });
  await expect(page.locator(VISUAL)).toContainText('Second para.');
  await expect(status(page)).toHaveText('All edits saved.');
  await expect.poll(source).toContain('First para.\n\nSecond para.');

  // What is dragged along with a list is only its words.
  await dropOn(paragraph, { html: '<ul><li>a</li><li>b</li></ul>', text: 'a\nb' });
  await expect.poll(source).toContain('a b');

  // Characters LaTeX reads are escaped, as when typing.
  await dropOn(paragraph, { text: '50% of R&D' });
  await expect.poll(source).toContain('50\\% of R\\&D');

  // The source view takes no file either: it is not opened in the tab, and nothing goes in.
  const text = await source();
  await showSource(page);
  const inSource = await dropOn(page.locator(SOURCE), { file: bib });
  expect(inSource.drop, 'the drop of a file on the source was cancelled').toBe(true);
  await expect(note).toContainText('A picture or file cannot be dropped into the text.');
  await expect(page.locator(`${SOURCE} .cm-line`).first()).toBeVisible();
  await view(page, 'Visual').click();
  expect(await source()).toBe(text);
});

test('a caret at the end of the source is kept in the visual view', async ({ browser }) => {
  const { page, email } = await person(browser, 'vis-caret');
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'Latency stays below forty milliseconds for most edits.',
    '\\end{document}',
    '',
  ].join('\n');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Caret ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(status(page)).toHaveText('All edits saved.');

  // After \end{document} no text can go. The visual view used to put the caret there all the
  // same, where it is not drawn, and the editor's library warned of it (`person` refuses such
  // warnings). Now it goes to the nearest place that can take text.
  await showSource(page);
  await page.locator(SOURCE).click();
  await page.keyboard.press('ControlOrMeta+End');
  await view(page, 'Visual').click();
  await expect(page.locator(VISUAL)).toBeVisible();
  await page.waitForTimeout(1000);
  await page.keyboard.type('Z');
  await expect(page.locator(VISUAL)).toContainText('Z');
});
