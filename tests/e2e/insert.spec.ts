// Inserting a reference or an equation in the visual view: from the toolbar, from the keyboard
// and from the menu at a place in the text. Needs the services, the sync server and the worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import {
  audit,
  clickAfter,
  emailedLink,
  person,
  run,
  showSource,
  showVisual,
  signIn,
  slowPaper,
  sourceText,
} from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');
const VISUAL = '.editor .visual .ProseMirror';

/** Put the caret just after a word in the visual view, the way a person would: click, then End. */
async function caretAfter(page: Page, word: string) {
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
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, end: r.right - 1 };
      }
      return null;
    },
    [VISUAL, word] as const,
  );
  if (!at) throw new Error(`"${word}" is not shown`);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe(word);
  await page.keyboard.press('ArrowRight');
  return at;
}

test('references and equations are inserted from the toolbar, the keyboard and the menu', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { page, email } = await person(browser, 'insert-owner');
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Insert ${run}.zip`);
  writeFileSync(zip, await writeZip(files));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  await page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 60_000,
  });

  // Toolbar: a reference, chosen from the paper's labels with their numbers beside them.
  await caretAfter(page, 'Reviewers');
  await page.getByRole('button', { name: 'Reference' }).click();
  const picker = page.getByRole('dialog', { name: 'Insert a reference' });
  await expect(picker.getByRole('option')).toHaveCount(7);
  await picker.getByLabel('Find a label').fill('results');
  await expect(picker.getByRole('option')).toHaveText([
    'sec:results, number III (sections/results.tex)',
  ]);
  await expect(picker).toContainText('Inserts \\ref{sec:results}.');
  await picker.getByRole('button', { name: 'Insert' }).click();
  await expect(picker).toBeHidden();
  const inserted = page.locator(`${VISUAL} p`, { hasText: 'Reviewers' }).locator('.pw-ref');
  await expect(inserted).toHaveAttribute('aria-label', /^reference to sec:results:/);

  // Keyboard: Alt+R, type to find, Enter. An equation label is referred to in brackets.
  await caretAfter(page, 'opposite');
  await page.keyboard.press('Alt+r');
  await picker.getByLabel('Find a label').fill('commute');
  await expect(picker).toContainText('Inserts \\eqref{eq:commute}.');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  // The keyboard is back in the text, where it was.
  await page.keyboard.type(' as shown');

  // A citation, chosen from the bibliography by author, year or title. The paper's existing
  // citation says what it cites; the new one uses the command the paper already uses.
  const cited = page.locator(`${VISUAL} .pw-cite`);
  await expect(cited.first()).toHaveAttribute('aria-label', /^citation: Knuth 1984\. /);
  await caretAfter(page, 'whitespace');
  await page.keyboard.press('Alt+c');
  const citing = page.getByRole('dialog', { name: 'Insert a citation' });
  await citing.getByLabel(/^Find an entry/).fill('nobody wrote this');
  await expect(citing).toContainText('Nothing matches.');
  await citing.getByLabel(/^Find an entry/).fill('knuth 1984');
  await expect(citing.getByRole('option')).toHaveText([/^knuth1984: Knuth 1984\. /]);
  await expect(citing).toContainText('Inserts \\cite{knuth1984}.');
  await page.keyboard.press('Enter');
  await expect(citing).toBeHidden();
  await expect(cited).toHaveCount(2);
  await expect(cited.nth(1)).not.toHaveClass(/pw-unknown/);

  // Keyboard: Alt+= for an equation in the line, with a preview as it is typed.
  await caretAfter(page, 'characters');
  await page.keyboard.press('Alt+=');
  const box = page.getByRole('dialog', { name: 'Insert an equation' });
  await expect(box.getByLabel('In the line')).toBeChecked();
  await box.getByLabel('LaTeX').fill('n \\le 3');
  await expect(box.locator('.preview .katex')).toBeVisible();
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box).toBeHidden();

  // The menu at a place in the text: an equation on a line of its own. A right click puts the
  // caret where it lands, here at the end of a word.
  const word = await caretAfter(page, 'organised');
  const where = { x: word.end, y: word.y };
  await page.mouse.click(where.x, where.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'At this place' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Insert a reference…',
    'Insert a citation…',
    'Insert an equation…',
    'Insert a figure…',
    'Insert a table…',
    'Insert a heading…',
    'Insert a bulleted list',
    'Insert a numbered list',
  ]);
  // It can be worked from the keyboard, and put away with Escape.
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  // The place the arrow keys reached is kept while the editor draws itself again, as it does
  // whenever anyone arrives, moves or types. Here the same person opens the file a second time.
  const second = await page.context().newPage();
  await second.goto(page.url());
  await expect(page.getByText(`Also here: ${email}`)).toBeVisible();
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await second.close();
  await expect(page.getByText('Nobody else is here.')).toBeVisible();
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.mouse.click(where.x, where.y, { button: 'right' });
  await menu.getByRole('menuitem', { name: 'Insert an equation…' }).click();
  await box.getByLabel('On a line of its own, numbered').check();
  await box.getByLabel('LaTeX').fill('a^2 + b^2 = c^2');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box).toBeHidden();
  await expect(page.locator(`${VISUAL} div.pw-math .katex`)).toBeVisible();

  // On a formula, the menu offers to edit it.
  await page.locator(`${VISUAL} span.pw-math`, { hasText: 'n' }).first().click({ button: 'right' });
  await expect(menu.getByRole('menuitem').first()).toHaveText('Edit formula…');
  await menu.getByRole('menuitem', { name: 'Edit formula…' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit formula' });
  await expect(edit.getByLabel('LaTeX')).toHaveValue('$n \\le 3$');
  await edit.getByRole('button', { name: 'Cancel' }).click();

  // What is in the file is exactly what was asked for, and nothing else changed.
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );
  await page.goto(paper);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  const back = await readZip(readFileSync(await download.path()));
  const text = Buffer.from(
    back.entries.find((e) => e.path === 'sections/intro.tex')!.bytes,
  ).toString();
  const original = files.find((f) => f.path === 'sections/intro.tex')!.bytes.toString();
  expect(text).toBe(
    original
      .replace('Reviewers', 'Reviewers\\ref{sec:results}')
      .replace('opposite', 'opposite\\eqref{eq:commute} as shown')
      .replace('and whitespace', 'and whitespace\\cite{knuth1984}')
      .replace('characters', 'characters$n \\le 3$')
      .replace('organised', 'organised\n\\begin{equation}\n  a^2 + b^2 = c^2\n\\end{equation}\n'),
  );
});

test('an equation that would break the build is refused in the Insert window', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'insert-formula');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Formula ${run}.zip`);
  const main =
    '\\documentclass{article}\n\\begin{document}\nHello world here.\n\nSecond paragraph.\n\\end{document}\n';
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  const status = page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
  await expect(status).toHaveText('All edits saved.');
  const box = page.getByRole('dialog', { name: 'Insert an equation' });
  await showSource(page);
  const before = await sourceText(page);
  await showVisual(page);

  // A % in a formula comments out the rest of the line, and the preview does not show it.
  await clickAfter(page, VISUAL, 'world');
  await page.keyboard.press('Alt+=');
  await box.getByLabel('LaTeX').fill('p = 50%');
  await expect(box.locator('.preview .katex')).toBeVisible();
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toContainText('make the change in the source');
  await expect(box).toBeVisible();
  await expect(box.getByLabel('LaTeX')).toHaveValue('p = 50%');
  await audit(page, 'equation window, with a refusal');
  // An unclosed brace, on a line of its own.
  await box.getByLabel('On a line of its own, numbered').check();
  await box.getByLabel('LaTeX').fill('\\frac{a}{b');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toContainText('make the change in the source');
  await expect(box).toBeVisible();
  await box.getByRole('button', { name: 'Cancel' }).click();
  await expect(box).toBeHidden();
  await expect(status).toHaveText('All edits saved.');
  await showSource(page);
  expect(await sourceText(page)).toBe(before);
  await showVisual(page);

  // Put right, it goes in, and the caret is after it.
  await clickAfter(page, VISUAL, 'world');
  await page.keyboard.press('Alt+=');
  await box.getByLabel('LaTeX').fill('p = 50%');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toBeVisible();
  await box.getByLabel('LaTeX').fill('p = 50\\%');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box).toBeHidden();
  await page.keyboard.type('Z');
  await expect(status).toHaveText('All edits saved.');
  await showSource(page);
  expect(await sourceText(page)).toContain('$p = 50\\%$Z');
});

test('after an equation is put on a line of its own, typing carries on after it', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'insert-caret');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Caret ${run}.zip`);
  const main =
    '\\documentclass{article}\n\\begin{document}\nHello world here.\n\nSecond paragraph.\n\\end{document}\n';
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  const status = page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
  await expect(status).toHaveText('All edits saved.');
  const equation = async (after: string, latex: string) => {
    await clickAfter(page, VISUAL, after);
    await page.keyboard.press('Alt+=');
    const box = page.getByRole('dialog', { name: 'Insert an equation' });
    await box.getByLabel('On a line of its own, numbered').check();
    await box.getByLabel('LaTeX').fill(latex);
    await box.getByRole('button', { name: 'Insert' }).click();
    await expect(box).toBeHidden();
    await expect(page.locator(`${VISUAL} div.pw-math .katex`).last()).toBeVisible();
  };

  // In the middle of a paragraph. Just after the equation is between two blocks, where no text
  // can go: the caret takes the next place that can, which is the rest of the paragraph. It
  // once stayed between the blocks, was not drawn, and what was typed landed before the equation.
  await equation('world', 'a = 1');
  await page.keyboard.type('AFTER');
  // At the end of a paragraph: the next place is the start of the paragraph that follows.
  await equation('here.', 'b = 2');
  await page.keyboard.type('NEXT');
  // A table goes in by the same road: where the caret is. The caret is put at the end of the
  // paragraph, which here is the last thing in the paper: nothing after the table can take
  // text, so the caret goes back to the nearest place before, the end of that paragraph. (The
  // click alone is not enough: three clicks within half a second of each other, near each
  // other, are a triple click to the editor, which selects the paragraph. Slower than that it
  // is a caret in the middle of the paragraph, and the table goes in there.)
  await clickAfter(page, VISUAL, 'Second');
  await page.keyboard.press('End');
  await page.getByRole('group', { name: 'Edit' }).getByRole('button', { name: 'Table' }).click();
  const table = page.getByRole('dialog', { name: 'Insert a table' });
  await table.getByLabel('Caption').fill('Sizes');
  await table.getByRole('button', { name: 'Insert' }).click();
  await expect(table).toBeHidden();
  await expect(page.locator(VISUAL).getByRole('group', { name: 'Table' })).toBeVisible();
  await page.keyboard.type('TABLED');
  await expect(status).toHaveText('All edits saved.');

  await showSource(page);
  const all = (await page.locator('.editor .cm-line').allTextContents()).filter((l) => l.trim());
  const tableAt = all.findIndex((l) => l.startsWith('\\begin{table}'));
  const tableEnd = all.findIndex((l) => l.startsWith('\\end{table}'));
  expect(all.slice(-8), 'the end of the file').toContain('\\end{table}');
  expect(tableAt).toBeGreaterThan(0);
  expect(all[tableAt - 1]).toBe('NEXTSecond paragraph.TABLED');
  const lines = [...all.slice(0, tableAt - 1), ...all.slice(tableEnd + 1)];
  expect(lines).toEqual([
    '\\documentclass{article}',
    '\\begin{document}',
    'Hello world',
    '\\begin{equation}',
    '  a = 1',
    '\\end{equation}',
    ' AFTERhere.',
    '\\begin{equation}',
    '  b = 2',
    '\\end{equation}',
    '\\end{document}',
  ]);
});

test('an insertion slow to arrive leaves the caret where its person put it', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { page, line } = await slowPaper(browser, 'insert-slow');
  const status = page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
  await clickAfter(page, VISUAL, 'alphaend');
  line.each = 1000;
  await page.keyboard.press('Alt+c');
  const citing = page.getByRole('dialog', { name: 'Insert a citation' });
  await citing.getByLabel(/^Find an entry/).fill('knuth');
  await expect(citing.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  // The window is dismissed and the caret put at the end of another paragraph before the
  // answer arrives, and typed in as slowly as a person does. The window's close event is held
  // back for 400 ms, as it is on a machine too busy to deliver it at once.
  await page.evaluate(() => {
    const d = document.querySelector('dialog[open]')!;
    d.addEventListener(
      'close',
      (e) => {
        e.stopImmediatePropagation();
        setTimeout(() => d.dispatchEvent(new Event('close')), 400);
      },
      { capture: true, once: true },
    );
  });
  await page.keyboard.press('Escape');
  // Hiding the window and focusing the text is the browser's doing, and is done at once; the
  // page's own return of the caret comes after, when the close event arrives. Then the person
  // clicks.
  await expect(citing).toBeHidden();
  await expect(page.locator(VISUAL)).toBeFocused();
  await clickAfter(page, VISUAL, 'charlieend');
  for (const ch of 'ab') {
    await page.keyboard.type(ch);
    await page.waitForTimeout(500);
  }
  // The answer comes while the person is still typing.
  await expect(
    page.locator(`${VISUAL} p`, { hasText: 'alphaend' }).locator('.pw-cite'),
  ).toHaveCount(1, { timeout: 15_000 });
  for (const ch of 'cd') {
    await page.keyboard.type(ch);
    await page.waitForTimeout(500);
  }
  await expect(status).toHaveText('All edits saved.', { timeout: 60_000 });
  line.each = 0;
  await showSource(page);
  const text = await page.locator('.editor .cm-content').innerText();
  expect(text).toContain('charlieendabcd');
  expect(text).toMatch(/alphaend\\cite\{knuth1984\}\./);
});

test('a heading is inserted from the toolbar, the keyboard and the menu, and taken back by undo', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'insert-heading');
  const other = await person(browser, 'insert-heading-2');
  const main =
    '\\documentclass{article}\n\\begin{document}\nHello world here.\n\nSecond paragraph.\n\\end{document}\n';
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Heading ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  // A second person, an editor, who has the file open from the start.
  await page.getByLabel('Their email address').fill(other.email);
  await page.getByLabel('Their role').selectOption('editor');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText(other.email);
  await other.page.goto(await emailedLink(other.email, '/invitations/'));
  await signIn(other.page, other.email);
  await other.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(other.page.getByText('You are an editor')).toBeVisible();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  const status = page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
  await expect(status).toHaveText('All edits saved.');
  await expect(page).toHaveURL(/\/files\//);
  await other.page.goto(page.url());
  await expect(other.page.locator(VISUAL)).toContainText('Hello world here.');

  /** The lines of the source that have something on them. */
  const lines = async () => {
    await showSource(page);
    const all = (await page.locator('.editor .cm-line').allTextContents()).filter((l) => l.trim());
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Visual' }).click();
    return all;
  };
  const edit = page.getByRole('group', { name: 'Edit' });
  const box = page.getByRole('dialog', { name: 'Insert a heading' });
  const original = [
    '\\documentclass{article}',
    '\\begin{document}',
    'Hello world here.',
    'Second paragraph.',
    '\\end{document}',
  ];
  expect(await lines()).toEqual(original);

  // The toolbar button, in the middle of a paragraph: it is split there. The window opens on the
  // title, and Enter inserts. The caret is then at the start of what was split off.
  await clickAfter(page, VISUAL, 'Hello');
  await edit.getByRole('button', { name: 'Heading' }).click();
  await expect(box).toBeVisible();
  await expect(box.getByLabel('Title')).toBeFocused();
  await box.getByLabel('Level').selectOption('subsection');
  await page.keyboard.type('Method');
  await page.keyboard.press('Enter');
  await expect(box).toBeHidden();
  await expect(page.locator(`${VISUAL} h3`)).toHaveText('Method');
  await expect(page.locator(VISUAL)).toBeFocused();
  await page.keyboard.type('NEXT');
  await expect(status).toHaveText('All edits saved.');
  expect(await lines()).toEqual([
    original[0],
    original[1],
    'Hello',
    '\\subsection{Method}',
    ' NEXTworld here.', // the space that followed the caret stays before the new paragraph's text
    original[3],
    original[4],
  ]);
  // A second person sees it.
  await expect(other.page.locator(`${VISUAL} h3`)).toHaveText('Method');

  // Undo takes it back in one step: the typed text first, then the heading.
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator(`${VISUAL} h3`)).toHaveCount(0);
  await expect(status).toHaveText('All edits saved.');
  expect(await lines()).toEqual(original);
  await expect(other.page.locator(`${VISUAL} h3`)).toHaveCount(0);

  // The keyboard: Alt+H, at the end of a paragraph; Escape puts it away and gives the caret back.
  await clickAfter(page, VISUAL, 'here.');
  await page.keyboard.press('End');
  await page.keyboard.press('Alt+h');
  await expect(box).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await expect(page.locator(VISUAL)).toBeFocused();
  // Refused, in the window, with the reason; nothing is inserted until it is right.
  await page.keyboard.press('Alt+h');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toHaveText('A heading needs a title.');
  await box.getByLabel('Title').fill('Bad { title');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toHaveText(
    'A title cannot hold an unescaped & or %, and its braces must match.',
  );
  await box.getByLabel('Title').fill('50% done');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toContainText('unescaped & or %');
  await box.getByLabel('Title').fill('Results for n_max');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toContainText('underscore');
  await expect(box).toBeVisible();
  await audit(page, 'heading window, with a refusal');
  await box.getByLabel('Title').fill('  Related \n  work  ');
  await page.keyboard.press('Enter');
  await expect(box).toBeHidden();
  await expect(page.locator(`${VISUAL} h2`)).toHaveText('Related work');
  await expect(status).toHaveText('All edits saved.');
  expect(await lines()).toEqual([
    original[0],
    original[1],
    'Hello world here.',
    '\\section{Related work}',
    original[3],
    original[4],
  ]);

  // The menu at a place in the text.
  const word = await caretAfter(page, 'Second');
  await page.mouse.click(word.end, word.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'At this place' });
  await menu.getByRole('menuitem', { name: 'Insert a heading…' }).click();
  await box.getByLabel('Level').selectOption('subsubsection');
  await box.getByLabel('Title').fill('Setup');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box).toBeHidden();
  await expect(page.locator(`${VISUAL} h4`)).toHaveText('Setup');
  await expect(status).toHaveText('All edits saved.');
  expect(await lines()).toEqual([
    original[0],
    original[1],
    'Hello world here.',
    '\\section{Related work}',
    'Second',
    '\\subsubsection{Setup}',
    ' paragraph.',
    original[4],
  ]);

  // Not in a paragraph (here, in a heading): said so, and no window.
  await page.locator(`${VISUAL} h2`).click();
  await edit.getByRole('button', { name: 'Heading' }).click();
  await expect(page.getByText('Put the caret in a paragraph to add a heading.')).toBeVisible();
  await expect(box).toBeHidden();
});

test('a list is started from the toolbar, the keyboard and the menu, and left with Enter in an empty item', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'insert-list');
  const other = await person(browser, 'insert-list-2');
  const main =
    '\\documentclass{article}\n\\begin{document}\nHello world here.\n\nSecond paragraph.\n\\end{document}\n';
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Lists ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByLabel('Their email address').fill(other.email);
  await page.getByLabel('Their role').selectOption('editor');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText(other.email);
  await other.page.goto(await emailedLink(other.email, '/invitations/'));
  await signIn(other.page, other.email);
  await other.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(other.page.getByText('You are an editor')).toBeVisible();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  const status = page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
  await expect(status).toHaveText('All edits saved.');
  await expect(page).toHaveURL(/\/files\//);
  await other.page.goto(page.url());
  await expect(other.page.locator(VISUAL)).toContainText('Hello world here.');

  /** The lines of the source that have something on them. */
  const lines = async () => {
    await showSource(page);
    const all = (await page.locator('.editor .cm-line').allTextContents()).filter((l) => l.trim());
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Visual' }).click();
    return all;
  };
  const edit = page.getByRole('group', { name: 'Edit' });
  const items = page.locator(`${VISUAL} li`);
  const theirs = other.page.locator(`${VISUAL} li`);
  const original = [
    '\\documentclass{article}',
    '\\begin{document}',
    'Hello world here.',
    'Second paragraph.',
    '\\end{document}',
  ];
  expect(await lines()).toEqual(original);

  // The toolbar, at the end of a paragraph. The caret is in the new item: type, Enter, type;
  // Enter in the empty last item leaves the list, and typing then lands in a paragraph after it.
  await clickAfter(page, VISUAL, 'here.');
  await page.keyboard.press('End');
  await edit.getByRole('button', { name: 'Bulleted list' }).click();
  await expect(items).toHaveCount(1);
  await expect(status).toHaveText('All edits saved.');
  expect(await lines()).toEqual([
    original[0],
    original[1],
    original[2],
    '\\begin{itemize}',
    '\\item ',
    '\\end{itemize}',
    original[3],
    original[4],
  ]);
  await expect(theirs).toHaveCount(1);
  await expect(page.locator(VISUAL)).toBeFocused();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await expect(items).toHaveCount(3);
  await page.keyboard.press('Enter');
  await expect(items).toHaveCount(2);
  await page.keyboard.type('After');
  await expect(status).toHaveText('All edits saved.');
  const withList = [
    original[0],
    original[1],
    original[2],
    '\\begin{itemize}',
    '\\item one',
    '\\item two',
    '\\end{itemize}',
    'After',
    original[3],
    original[4],
  ];
  expect(await lines()).toEqual(withList);
  // A second person sees it.
  await expect(theirs).toHaveText(['one', 'two']);
  await expect(other.page.locator(`${VISUAL} p`, { hasText: 'After' })).toHaveCount(1);

  // The keyboard: Alt+L, at the end of the last paragraph. Undo takes it back in one step.
  await clickAfter(page, VISUAL, 'paragraph.');
  await page.keyboard.press('End');
  await page.keyboard.press('Alt+l');
  await expect(items).toHaveCount(3);
  await page.keyboard.type('x');
  await expect(status).toHaveText('All edits saved.');
  expect((await lines()).slice(-4)).toEqual([
    '\\begin{itemize}',
    '\\item x',
    '\\end{itemize}',
    '\\end{document}',
  ]);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(items).toHaveCount(2);
  await expect(status).toHaveText('All edits saved.');
  expect(await lines()).toEqual(withList);
  await expect(theirs).toHaveCount(2);

  // The menu, in the middle of a paragraph: a numbered list, which is an enumerate.
  const word = await caretAfter(page, 'Hello');
  await page.mouse.click(word.end, word.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'At this place' });
  await menu.getByRole('menuitem', { name: 'Insert a numbered list' }).click();
  await expect(page.locator(`${VISUAL} ol li`)).toHaveCount(1);
  await expect(status).toHaveText('All edits saved.');
  const text = (await lines()).join('\n');
  expect(text).toContain('Hello\n\\begin{enumerate}\n\\item \n\\end{enumerate}\n world here.');
  await expect(other.page.locator(`${VISUAL} ol li`)).toHaveCount(1);

  // Not in a paragraph (here, in a list item): said so, and nothing is inserted.
  await items.first().click();
  await edit.getByRole('button', { name: 'Numbered list' }).click();
  await expect(page.getByText('Put the caret in a paragraph to add a list.')).toBeVisible();
  await expect(page.locator(`${VISUAL} ol li`)).toHaveCount(1);
  await audit(page, 'the file page with the list buttons and a refusal');
});

test('an equation, a heading, a list and a figure are removed from the visual view, and undo brings them back', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await person(browser, 'remove-owner');
  const other = await person(browser, 'remove-editor');
  const reviewer = await person(browser, 'remove-reviewer');
  const main =
    '\\documentclass{article}\n\\begin{document}\nHello world here.\n\nSecond paragraph.\n\n' +
    '\\begin{figure}\n\\caption{Cap}\n\\end{figure}\n\\end{document}\n';
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Remove ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  const { page } = owner;
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  for (const [who, role] of [
    [other, 'editor'],
    [reviewer, 'reviewer'],
  ] as const) {
    await page.getByLabel('Their email address').fill(who.email);
    await page.getByLabel('Their role').selectOption(role);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByRole('status')).toContainText(who.email);
    await who.page.goto(await emailedLink(who.email, '/invitations/'));
    await signIn(who.page, who.email);
    await who.page.getByRole('button', { name: 'Join this paper' }).click();
    await expect(
      who.page.getByText(`You are ${role === 'editor' ? 'an' : 'a'} ${role}`),
    ).toBeVisible();
  }
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  const status = page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
  await expect(status).toHaveText('All edits saved.');
  await expect(page).toHaveURL(/\/files\//);
  await other.page.goto(page.url());
  await expect(other.page.locator(VISUAL)).toContainText('Hello world here.');

  /** The source, every byte of it. */
  const bytes = async () => {
    await showSource(page);
    const all = await page.locator('.editor .cm-line').allTextContents();
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Visual' }).click();
    return all.join('\n');
  };
  expect(await bytes()).toBe(main);
  const theirs = (what: string) => other.page.locator(`${VISUAL} ${what}`);

  // An equation: put in at the end of a paragraph, selected with the arrow keys, deleted.
  await clickAfter(page, VISUAL, 'here.');
  await page.keyboard.press('End');
  await page.keyboard.press('Alt+=');
  const box = page.getByRole('dialog', { name: 'Insert an equation' });
  await box.getByLabel('On a line of its own, numbered').check();
  await box.getByLabel('LaTeX').fill('a = 1');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box).toBeHidden();
  await expect(page.locator(`${VISUAL} div.pw-math .katex`)).toBeVisible();
  await expect(status).toHaveText('All edits saved.');
  await expect(theirs('div.pw-math')).toHaveCount(1);
  const withEquation = await bytes();
  expect(withEquation).toContain('\\begin{equation}');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(`${VISUAL} .ProseMirror-selectednode`)).toHaveCount(1);
  await page.keyboard.press('Delete');
  await expect(page.locator(`${VISUAL} div.pw-math`)).toHaveCount(0);
  await expect(status).toHaveText('All edits saved.');
  expect(await bytes()).toBe(main);
  await expect(theirs('div.pw-math')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator(`${VISUAL} div.pw-math`)).toHaveCount(1);
  await expect(status).toHaveText('All edits saved.');
  expect(await bytes()).toBe(withEquation);
  await expect(theirs('div.pw-math')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator(`${VISUAL} div.pw-math`)).toHaveCount(0);
  await expect(status).toHaveText('All edits saved.');
  expect(await bytes()).toBe(main);

  // A heading: its title is cleared, and Backspace in the empty heading removes it.
  await clickAfter(page, VISUAL, 'here.');
  await page.keyboard.press('End');
  await page.keyboard.press('Alt+h');
  const heading = page.getByRole('dialog', { name: 'Insert a heading' });
  await heading.getByLabel('Title').fill('Temp');
  await page.keyboard.press('Enter');
  await expect(heading).toBeHidden();
  const h2 = page.locator(`${VISUAL} h2`);
  await expect(h2).toHaveText('Temp');
  await expect(theirs('h2')).toHaveText('Temp');
  await h2.click();
  await page.keyboard.press('End');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
  await expect(h2).toHaveText('');
  await expect(status).toHaveText('All edits saved.');
  expect(await bytes()).toContain('\\section{}');
  await page.keyboard.press('Backspace');
  await expect(h2).toHaveCount(0);
  await expect(status).toHaveText('All edits saved.');
  expect(await bytes()).toBe(main);
  await expect(theirs('h2')).toHaveCount(0);
  // The caret is in the text, not lost: typing lands in the paragraph before.
  await page.keyboard.type('!');
  await expect(page.locator(`${VISUAL} p`, { hasText: 'Hello world here.!' })).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(status).toHaveText('All edits saved.');
  expect(await bytes()).toBe(main);

  // A list: Backspace in its one empty item removes the list.
  await clickAfter(page, VISUAL, 'here.');
  await page.keyboard.press('End');
  await page.keyboard.press('Alt+l');
  await expect(page.locator(`${VISUAL} li`)).toHaveCount(1);
  await expect(theirs('li')).toHaveCount(1);
  await expect(page.locator(VISUAL)).toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(page.locator(`${VISUAL} li`)).toHaveCount(0);
  await expect(status).toHaveText('All edits saved.');
  expect(await bytes()).toBe(main);
  await expect(theirs('li')).toHaveCount(0);

  // A reviewer sees the figure and a way to its source, but no way to remove it.
  await reviewer.page.goto(page.url());
  await expect(reviewer.page.locator(VISUAL)).toHaveAttribute('aria-readonly', 'true');
  await expect(reviewer.page.locator(VISUAL)).toHaveAttribute('contenteditable', 'true');
  const there = reviewer.page.locator(VISUAL).getByRole('group', { name: 'Figure' });
  await expect(there.getByRole('button', { name: 'Edit in source' })).toBeVisible();
  await expect(reviewer.page.getByRole('button', { name: 'Remove figure' })).toHaveCount(0);

  // A figure: its Remove button, reachable by keyboard, passes the accessibility check.
  const fig = page.locator(VISUAL).getByRole('group', { name: 'Figure' });
  const remove = fig.getByRole('button', { name: 'Remove figure' });
  await expect(remove).toBeVisible();
  await audit(page, 'a figure with its Remove button');
  await remove.focus();
  await expect(remove).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(fig).toHaveCount(0);
  await expect(status).toHaveText('All edits saved.');
  const without = main.replace('\\begin{figure}\n\\caption{Cap}\n\\end{figure}\n', '');
  expect(await bytes()).toBe(without);
  await expect(other.page.locator(VISUAL).getByRole('group', { name: 'Figure' })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(fig).toHaveCount(1);
  await expect(status).toHaveText('All edits saved.');
  expect(await bytes()).toBe(main);
});

test('the menu at a place stays inside the window, near its bottom edge and in a small one', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { page, email } = await person(browser, 'insert-edge');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Edge ${run}.zip`);
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph number${i} ends here.`);
  const main = `\\documentclass{article}\n\\begin{document}\n${paragraphs.join('\n\n')}\n\\end{document}\n`;
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );
  const menu = page.getByRole('menu', { name: 'At this place' });
  const inside = async () => {
    const view = page.viewportSize()!;
    const items = menu.getByRole('menuitem');
    await expect(items.first()).toBeVisible();
    for (const item of await items.all()) {
      const b = (await item.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(view.height);
      expect(b.x + b.width).toBeLessThanOrEqual(view.width);
    }
  };
  for (const size of [
    { width: 1280, height: 720 },
    { width: 320, height: 480 },
  ]) {
    await page.setViewportSize(size);
    // The last paragraph is scrolled to the bottom edge of the window.
    const word = 'number39';
    await page.evaluate(
      ([sel, w]) => {
        const walker = document.createTreeWalker(
          document.querySelector(sel)!,
          NodeFilter.SHOW_TEXT,
        );
        for (let n = walker.nextNode(); n; n = walker.nextNode())
          if (n.textContent!.includes(w)) n.parentElement!.scrollIntoView({ block: 'end' });
      },
      [VISUAL, word] as const,
    );
    await caretAfter(page, word);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    // From the keyboard: at the caret, and with the keyboard on an item that can be seen.
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await inside();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    // From a right click on the last line, at the right-hand end of the text.
    const last = (await page.locator(`${VISUAL} p`, { hasText: word }).boundingBox())!;
    await page.mouse.click(
      Math.min(last.x + last.width - 4, size.width - 4),
      Math.min(last.y + last.height - 4, size.height - 4),
      { button: 'right' },
    );
    await expect(menu).toBeVisible();
    await inside();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
});
