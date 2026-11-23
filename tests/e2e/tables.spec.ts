// Tables and captions in the visual view: a cell or a caption is edited where it stands, and
// the file changes in that cell or caption and nowhere else. Needs the services and the sync server.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import {
  clickAfter,
  person,
  run,
  selectWord,
  showSource,
  showVisual,
  signIn,
  slowPaper,
  typingSaved,
} from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');
const VISUAL = '.editor .visual .ProseMirror';
const source = (page: Page) => page.locator('.editor .cm-content');
const note = (page: Page) => page.locator('.editor .toolbar .note');

test('a table cell and a caption are edited in place, byte for byte', async ({ browser }) => {
  const { page, email } = await person(browser, 'table-owner');
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Tables ${run}.zip`);
  writeFileSync(zip, await writeZip(files));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  await page.getByRole('link', { name: 'tables/ablation.tex' }).click();
  await expect(page.getByRole('region', { name: 'Editor for tables/ablation.tex' })).toBeVisible();
  const file = page.url();
  // A second tab on the same file, in the source view.
  const other = await page.context().newPage();
  await other.goto(file);
  await showSource(other);
  await expect(source(other)).toContainText('article & 4000 & 0');

  // The table is a grid, with its caption above it.
  const table = page.locator(VISUAL).getByRole('group', { name: 'Table' });
  // Four rows of the table, and one of buttons under its columns.
  await expect(table.getByRole('row')).toHaveCount(5);
  await expect(table.getByRole('columnheader')).toHaveText([
    'Template',
    'Edits',
    'Out-of-range bytes',
  ]);
  const cell = (row: number, column: number) =>
    table.getByRole('button', { name: new RegExp(`^Row ${row}, column ${column}:`) });
  const field = (row: number, column: number) =>
    table.getByLabel(`Row ${row}, column ${column}`, { exact: true });

  // Press a cell, type, Enter: that cell changes, here and for everyone.
  await cell(2, 2).click();
  await expect(field(2, 2)).toHaveValue('4000');
  await field(2, 2).fill('4500');
  await page.keyboard.press('Enter');
  await expect(cell(2, 2)).toHaveText('4500');
  await expect(source(other)).toContainText('article & 4500 & 0');
  // Nothing to report: it went through.
  await expect(note(page)).toHaveText('');
  // LaTeX in a cell is kept as LaTeX and shown as it reads.
  await cell(3, 3).click();
  await field(3, 3).fill('0\\%');
  await page.keyboard.press('Enter');
  await expect(cell(3, 3)).toHaveText('0%');
  await expect(source(other)).toContainText('IEEEtran & 3000 & 0\\% \\\\');

  // Text that would break the grid is refused, and Escape leaves the cell as it was.
  await cell(4, 1).click();
  await field(4, 1).fill('ams & art');
  await page.keyboard.press('Enter');
  await expect(note(page)).toContainText('A cell cannot hold an unescaped &');
  // A # would stop the build: refused with the way to write it, and the field keeps the text.
  await field(4, 1).fill('#runs');
  await page.keyboard.press('Enter');
  await expect(note(page)).toContainText('Write \\#');
  await expect(field(4, 1)).toHaveValue('#runs');
  await page.keyboard.press('Escape');
  await expect(cell(4, 1)).toHaveText('amsart');
  await expect(cell(4, 1)).toBeFocused();

  // Someone else changes the cell while it is open here: theirs stands, and what was being
  // typed here is not lost without a word.
  await page.keyboard.press('Enter');
  await field(4, 1).fill('amsbook');
  await selectWord(other, '.editor .cm-content', 'amsart');
  await other.keyboard.type('amsproc');
  await typingSaved(other);
  await expect(note(page)).toHaveText(
    'Someone changed this table while you were editing it. Your text was not put in: amsbook',
  );
  await expect(cell(4, 1)).toHaveText('amsproc');
  await expect(source(other)).not.toContainText('amsbook');

  // Rows and columns. A new row below the last, with its first cell filled in.
  await table.getByRole('button', { name: 'Add a row below row 4' }).click();
  await expect(table.getByRole('row')).toHaveCount(6);
  await cell(5, 1).click();
  await field(5, 1).fill('beamer');
  await page.keyboard.press('Enter');
  await expect(source(other)).toContainText('beamer & & \\\\');
  // A column added and taken away again leaves the table as it was.
  await table.getByRole('button', { name: 'Add a column after column 3' }).click();
  await expect(table.getByRole('columnheader')).toHaveCount(4);
  await expect(source(other)).toContainText('\\begin{tabular}{@{}lrrl@{}}');
  await table.getByRole('button', { name: 'Delete column 4' }).click();
  await expect(table.getByRole('columnheader')).toHaveCount(3);
  await expect(source(other)).toContainText('\\begin{tabular}{@{}lrr@{}}');
  // A row taken away goes with its line, and the rule above it stays.
  await table.getByRole('button', { name: 'Delete row 2' }).click();
  await expect(table.getByRole('row')).toHaveCount(5);
  await expect(source(other)).not.toContainText('article');
  await expect(cell(2, 1)).toHaveText('IEEEtran');

  // The caption is edited the same way.
  await table.getByRole('button', { name: /^Caption:/ }).click();
  await table.getByLabel('Caption', { exact: true }).fill('Edits checked, by template');
  await page.keyboard.press('Enter');
  await expect(table.getByRole('button', { name: /^Caption:/ })).toHaveText(
    'Edits checked, by template',
  );
  // Enter on a part that has not changed puts nothing in, and leaves the keyboard on its button.
  await cell(2, 1).click();
  await page.keyboard.press('Enter');
  await expect(cell(2, 1)).toBeFocused();
  await table.getByRole('button', { name: /^Caption:/ }).click();
  await page.keyboard.press('Enter');
  await expect(table.getByRole('button', { name: /^Caption:/ })).toBeFocused();
  // And a figure's, in another file.
  await page.getByRole('link', { name: 'sections/results.tex' }).click();
  // The other tab chose the source view, which this browser now opens files in.
  await showVisual(page);
  const figure = page.locator(VISUAL).getByRole('group', { name: 'Figure' });
  await figure.getByRole('button', { name: /^Caption:/ }).click();
  // Text that would stop the build is refused, and the field stays open with what was typed.
  for (const bad of ['Latency for 95% of runs', 'Ends \\']) {
    await figure.getByLabel('Caption', { exact: true }).fill(bad);
    await page.keyboard.press('Enter');
    await expect(note(page)).toContainText('A caption cannot hold');
    await expect(figure.getByLabel('Caption', { exact: true })).toHaveValue(bad);
  }
  // An underscore outside a formula stops the build too.
  await figure.getByLabel('Caption', { exact: true }).fill('Latency in ms_p95');
  await page.keyboard.press('Enter');
  await expect(note(page)).toContainText('Write \\_');
  await expect(figure.getByLabel('Caption', { exact: true })).toHaveValue('Latency in ms_p95');
  await figure.getByLabel('Caption', { exact: true }).fill('Latency, to be measured.');
  await page.keyboard.press('Enter');
  await expect(figure.getByRole('button', { name: /^Caption:/ })).toHaveText(
    'Latency, to be measured.',
  );
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );

  // The files differ from the upload in those cells and captions, and nowhere else.
  await page.goto(paper);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  const back = await readZip(readFileSync(await download.path()));
  const text = (path: string) =>
    Buffer.from(back.entries.find((e) => e.path === path)!.bytes).toString();
  const original = (path: string) => files.find((f) => f.path === path)!.bytes.toString();
  expect(text('tables/ablation.tex')).toBe(
    original('tables/ablation.tex')
      .replace('    article & 4000 & 0 \\\\\n', '')
      .replace('IEEEtran & 3000 & 0 ', 'IEEEtran & 3000 & 0\\% ')
      .replace(
        '    amsart & 3000 & 0 \\\\\n',
        '    amsproc & 3000 & 0 \\\\\n    beamer &  &  \\\\\n',
      )
      .replace('Edits checked per template', 'Edits checked, by template'),
  );
  expect(text('sections/results.tex')).toBe(
    original('sections/results.tex').replace(
      'Placeholder for the latency plot.',
      'Latency, to be measured.',
    ),
  );
});

test('commented rows and wrapped captions are left as they are', async ({ browser }) => {
  const { page, email } = await person(browser, 'table-comments');
  const tex = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\begin{table}',
    '\\caption{Scores on the',
    'benchmark.}',
    '\\begin{tabular}{lr}',
    'Name & Value \\\\ % header',
    'a & 1 \\\\',
    '% c & 3 \\\\',
    'b & 2 \\\\',
    '\\end{tabular}',
    '\\end{table}',
    '\\end{document}',
    '',
  ].join('\n');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Comments ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(tex) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  const other = await page.context().newPage();
  await other.goto(page.url());
  await showSource(other);
  await expect(source(other)).toContainText('Name & Value');
  const lines = other.locator('.editor .cm-content .cm-line');
  const sourceLines = async () => (await lines.allTextContents()).map((l) => l.trimEnd());

  const table = page.locator(VISUAL).getByRole('group', { name: 'Table' });
  // Three rows of the table, and one of buttons; the commented-out row is not there.
  await expect(table.getByRole('row')).toHaveCount(4);
  const cell = table.getByRole('button', { name: /^Row 3, column 1:/ });
  await expect(cell).toHaveText('b');
  await cell.click();
  const field = table.getByLabel('Row 3, column 1', { exact: true });
  await expect(field).toHaveValue('b');
  await field.fill('bb');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveText('bb');
  await expect(note(page)).toHaveText('');
  await expect.poll(sourceLines).toContain('bb & 2 \\\\');
  expect(await sourceLines()).toContain('% c & 3 \\\\');

  // A caption that wraps reads as one line, and Enter without a change leaves it wrapped.
  const caption = table.getByRole('button', { name: /^Caption:/ });
  await caption.click();
  const captionField = table.getByLabel('Caption', { exact: true });
  await expect(captionField).toHaveValue('Scores on the benchmark.');
  await page.keyboard.press('Enter');
  await expect(caption).toBeFocused();
  await expect(note(page)).toHaveText('');
  expect(await sourceLines()).toEqual(
    expect.arrayContaining(['\\caption{Scores on the', 'benchmark.}']),
  );
  await caption.click();
  await captionField.fill('Scores on the new benchmark.');
  await page.keyboard.press('Enter');
  await expect(caption).toHaveText('Scores on the new benchmark.');
  await expect.poll(sourceLines).toContain('\\caption{Scores on the new benchmark.}');
});

test('a row added to a one-column table shows, and its cell is edited alone', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'table-one-column');
  const tex = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\begin{table}',
    '\\begin{tabular}{l}',
    '  alpha \\\\',
    '  beta \\\\',
    '\\end{tabular}',
    '\\end{table}',
    '\\end{document}',
    '',
  ].join('\n');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `One column ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(tex) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  const other = await page.context().newPage();
  await other.goto(page.url());
  await showSource(other);
  await expect(source(other)).toContainText('alpha');
  const lines = other.locator('.editor .cm-content .cm-line');
  const sourceLines = async () => (await lines.allTextContents()).map((l) => l.trimEnd());

  const table = page.locator(VISUAL).getByRole('group', { name: 'Table' });
  // Two rows of the table, and one of buttons.
  await expect(table.getByRole('row')).toHaveCount(3);
  await table.getByRole('button', { name: 'Add a row below row 2' }).click();
  await expect(table.getByRole('row')).toHaveCount(4);
  // Pressing it again adds a second row, not another blank line under the same one.
  await table.getByRole('button', { name: 'Add a row below row 3' }).click();
  await expect(table.getByRole('row')).toHaveCount(5);
  const cell = table.getByRole('button', { name: /^Row 3, column 1:/ });
  await cell.click();
  await table.getByLabel('Row 3, column 1', { exact: true }).fill('gamma');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveText('gamma');
  await expect.poll(sourceLines).toContain('  gamma \\\\');
  const after = await sourceLines();
  expect(after.filter((l) => l.trim() === '\\\\')).toHaveLength(1);
  expect(after.filter((l) => /alpha|beta/.test(l))).toEqual(['  alpha \\\\', '  beta \\\\']);
});

test('a cell slow to be changed does not take the keyboard back', async ({ browser }) => {
  test.setTimeout(150_000);
  const { page, line } = await slowPaper(browser, 'table-slow');
  const status = page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
  line.each = 1000;
  const table = page.locator(VISUAL).getByRole('group', { name: 'Table' });
  await table.getByRole('button', { name: /^Row 2, column 2:/ }).click();
  await table.getByLabel('Row 2, column 2', { exact: true }).fill('7777');
  await page.keyboard.press('Enter');
  // The person goes on typing above the table before the answer arrives (some of it, so that
  // the table has moved down by the time it does).
  await clickAfter(page, VISUAL, 'charlieend');
  await page.keyboard.type('ab');
  // The answer comes while the person is still typing.
  await expect(table.getByRole('button', { name: /^Row 2, column 2: 7777/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.type('cd');
  await expect(status).toHaveText('All edits saved.', { timeout: 60_000 });
  line.each = 0;
  await showSource(page);
  const text = await page.locator('.editor .cm-content').innerText();
  expect(text).toContain('charlieendabcd.');
  expect(text).toContain('7777');
});
