// Inserting a reference or an equation in the visual view: from the toolbar, from the keyboard
// and from the menu at a place in the text. Needs the services, the sync server and the worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { clickAfter, person, run, showSource, signIn } from './helpers';

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
  ]);
  // It can be worked from the keyboard, and put away with Escape.
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
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
  // A table goes in by the same road. It is put after the paragraph it was asked for in,
  // which here is the last thing in the paper: nothing after it can take text, so the caret
  // goes back to the nearest place before, the end of that paragraph.
  await clickAfter(page, VISUAL, 'Second');
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
