// A figure in the visual view shows its picture, and its description for people who cannot see
// it is added and edited in place. Needs Docker, the TeX image, the services and the workers.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { clickAfter, person, run, showSource, signIn } from './helpers';

// A small valid PNG: a black square on white.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAAFklEQVR4nGP4DwUMSAwGBgYGQgw0XQC54i/RD0GiIwAAAABJRU5ErkJggg==',
  'base64',
);
const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\begin{document}',
  'Text before the figure.',
  '',
  '\\begin{figure}[t]',
  '  \\centering',
  '  \\includegraphics[width=2cm]{figures/dot}',
  '  \\caption{A dot.}',
  '  \\label{fig:dot}',
  '\\end{figure}',
  '',
  'Text after the figure.',
  '\\end{document}',
  '',
].join('\n');
const VISUAL = '.editor .visual .ProseMirror';
const source = (page: Page) => page.locator('.editor .cm-content');
const note = (page: Page) => page.locator('.editor .toolbar .note');

test('a figure shows its picture, and is given a description in place', async ({ browser }) => {
  test.setTimeout(150_000);
  const { page, email } = await person(browser, 'figure-owner');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Figures ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'figures/dot.png', bytes: PNG },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  await page.getByRole('link', { name: 'main.tex' }).click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  const other = await page.context().newPage();
  await other.goto(page.url());
  await showSource(other);

  // The picture itself is there, found the way LaTeX finds it: no extension was written.
  const figure = page.locator(VISUAL).getByRole('group', { name: 'Figure' });
  const picture = figure.locator('img');
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(8);
  // Pictures are fetched as they are scrolled near, so that a file of many figures does not
  // fetch them all to show its first page.
  await expect(picture).toHaveAttribute('loading', 'lazy');
  // It has no description, and that is said rather than left blank.
  const described = figure.getByRole('button', { name: /^Description of figures\/dot:/ });
  await expect(described).toHaveText('None yet. Add one.');
  await expect(described).toHaveClass(/pw-missing/);
  await expect(picture).toHaveAttribute('alt', '');

  // Characters LaTeX would read as something else are refused, with the reason.
  await described.click();
  const field = figure.getByLabel('Description of figures/dot', { exact: true });
  await field.fill('50% of a dot');
  await page.keyboard.press('Enter');
  await expect(note(page)).toContainText('A description cannot hold');
  // A plain description goes into the picture's options, and nothing else moves.
  await field.fill('A black square on a white ground');
  await page.keyboard.press('Enter');
  await expect(described).toHaveText('A black square on a white ground');
  await expect(described).not.toHaveClass(/pw-missing/);
  await expect(picture).toHaveAttribute('alt', 'A black square on a white ground');
  await expect(source(other)).toContainText(
    '\\includegraphics[width=2cm,alt={A black square on a white ground}]{figures/dot}',
  );
  // Changing it changes only it.
  await described.click();
  await field.fill('A black square');
  await page.keyboard.press('Enter');
  await expect(source(other)).toContainText(
    '\\includegraphics[width=2cm,alt={A black square}]{figures/dot}',
  );

  // A new figure, from the toolbar: choose one of the paper's pictures, describe it, caption it.
  await clickAfter(page, VISUAL, 'after');
  await page.getByRole('group', { name: 'Edit' }).getByRole('button', { name: 'Figure' }).click();
  const box = page.getByRole('dialog', { name: 'Insert a figure' });
  await expect(box.getByLabel('Picture').getByRole('option')).toHaveText([
    'figures/dot.png',
    'None yet',
  ]);
  await box.getByLabel(/^Description/).fill('Another square');
  await box.getByLabel('Caption').fill('A second dot & more');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toContainText('A caption cannot hold an unescaped &');
  await box.getByLabel('Caption').fill('A second dot');
  await box.getByRole('button', { name: 'Insert' }).click();
  // The editor gives the server eight seconds to answer. If the edit is refused, the window
  // says why, and so does this.
  await expect(async () => {
    expect(await box.getByRole('alert').allTextContents()).toEqual([]);
    await expect(box).toBeHidden({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  const figures = page.locator(VISUAL).getByRole('group', { name: 'Figure' });
  await expect(figures).toHaveCount(2);
  await expect(figures.nth(1).locator('img')).toHaveAttribute('alt', 'Another square');
  await expect(figures.nth(1).getByRole('button', { name: /^Caption:/ })).toHaveText(
    'A second dot',
  );

  // A new table, from the keyboard: Alt+T, a size, a caption. Its cells are then filled in place.
  await clickAfter(page, VISUAL, 'before');
  await page.keyboard.press('Alt+t');
  const tableBox = page.getByRole('dialog', { name: 'Insert a table' });
  await tableBox.getByLabel(/^Rows/).fill('2');
  await tableBox.getByLabel('Columns').fill('2');
  await tableBox.getByLabel('Caption').fill('Sizes');
  await tableBox.getByRole('button', { name: 'Insert' }).click();
  await expect(tableBox).toBeHidden();
  const table = page.locator(VISUAL).getByRole('group', { name: 'Table' });
  await expect(table.getByRole('columnheader')).toHaveText(['Column 1', 'Column 2']);
  // Two rows of the table, and one of buttons under its columns.
  await expect(table.getByRole('row')).toHaveCount(3);
  await table.getByRole('button', { name: /^Row 2, column 1:/ }).click();
  await table.getByLabel('Row 2, column 1', { exact: true }).fill('8 px');
  await page.keyboard.press('Enter');
  await expect(table.getByRole('button', { name: /^Row 2, column 1:/ })).toHaveText('8 px');

  // The paper still builds with all of it in.
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });

  await page.goto(paper);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  const back = await readZip(readFileSync(await download.path()));
  const bytes = (path: string) => Buffer.from(back.entries.find((e) => e.path === path)!.bytes);
  expect(bytes('main.tex').toString()).toBe(
    MAIN.replace('[width=2cm]', '[width=2cm,alt={A black square}]')
      .replace(
        'Text after',
        [
          'Text after',
          '\\begin{figure}[t]',
          '  \\centering',
          '  \\includegraphics[width=\\linewidth,alt={Another square}]{figures/dot.png}',
          '  \\caption{A second dot}',
          '  \\label{fig:a-second-dot}',
          '\\end{figure}',
          '',
        ].join('\n'),
      )
      .replace(
        'Text before',
        [
          'Text before',
          '\\begin{table}[t]',
          '  \\centering',
          '  \\caption{Sizes}',
          '  \\label{tab:sizes}',
          '  \\begin{tabular}{ll}',
          '    \\hline',
          '    Column 1 & Column 2 \\\\',
          '    \\hline',
          '    8 px &  \\\\',
          '    \\hline',
          '  \\end{tabular}',
          '\\end{table}',
          '',
        ].join('\n'),
      ),
  );
  expect(bytes('figures/dot.png').equals(PNG)).toBe(true);
});

test('a picture whose name LaTeX cannot spell is not put in a figure', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, email } = await person(browser, 'figure-hostile');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Hostile ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: '50%.png', bytes: PNG },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  await showSource(page);
  await expect(source(page)).toContainText('Text after the figure.');
  await clickAfter(page, VISUAL, 'after');
  await page.getByRole('group', { name: 'Edit' }).getByRole('button', { name: 'Figure' }).click();
  const box = page.getByRole('dialog', { name: 'Insert a figure' });
  await box.getByLabel('Picture').selectOption('50%.png');
  await box.getByLabel('Caption').fill('Half');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toHaveText(
    "LaTeX cannot use this picture's name. Rename it first.",
  );
  await expect(source(page)).not.toContainText('50%.png');
  await expect(page.locator(VISUAL).getByRole('group', { name: 'Figure' })).toHaveCount(1);
});
