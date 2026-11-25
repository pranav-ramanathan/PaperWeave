// A figure in the visual view shows its picture, and its description for people who cannot see
// it is added and edited in place. Needs Docker, the TeX image, the services and the workers.
import { type Browser, expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { audit, clickAfter, person, run, showSource, signIn, sourceText } from './helpers';

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
  await audit(page, 'a figure with no description');
  // Enter with nothing typed puts nothing in, and leaves the keyboard on the button.
  await described.click();
  await page.keyboard.press('Enter');
  await expect(described).toBeFocused();

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
  // The other page has the new text before this one has drawn it. This page draws the figure
  // again: it goes, and the text below it moves up, until the picture is back and fetched. The
  // click below is made where the text is, so wait until the figure is as it will stay.
  await expect(picture).toHaveAttribute('alt', 'A black square');
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(8);
  await expect(described).toHaveText('A black square');

  // A new figure, from the toolbar: choose one of the paper's pictures, describe it, caption it.
  await clickAfter(page, VISUAL, 'after');
  await page.getByRole('group', { name: 'Edit' }).getByRole('button', { name: 'Figure' }).click();
  const box = page.getByRole('dialog', { name: 'Insert a figure' });
  await expect(box.getByLabel('Picture').getByRole('option')).toHaveText([
    'figures/dot.png',
    'No picture yet',
  ]);
  await box.getByLabel(/^Description/).fill('Another square');
  await box.getByLabel('Caption').fill('A second dot & more');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toContainText('A caption cannot hold an unescaped &');
  await box.getByLabel('Caption').fill('Cost in $');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toContainText('Write \\$');
  await expect(box).toBeVisible();
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
  // A float goes after the paragraph the caret was in (the figure's caret was mid-sentence), in
  // blank lines, so that it does not split the paragraph.
  expect(bytes('main.tex').toString()).toBe(
    MAIN.replace('[width=2cm]', '[width=2cm,alt={A black square}]')
      .replace(
        'Text after the figure.\n',
        [
          'Text after the figure.',
          '',
          '\\begin{figure}[t]',
          '  \\centering',
          '  \\includegraphics[width=\\linewidth,alt={Another square}]{figures/dot.png}',
          '  \\caption{A second dot}',
          '  \\label{fig:a-second-dot}',
          '\\end{figure}',
          '',
          '',
        ].join('\n'),
      )
      .replace(
        'Text before the figure.\n',
        [
          'Text before the figure.',
          '',
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
  const other = await page.context().newPage();
  await other.goto(page.url());
  await showSource(other);
  await expect(source(other)).toContainText('Text after the figure.');
  await clickAfter(page, VISUAL, 'after');
  await page.getByRole('group', { name: 'Edit' }).getByRole('button', { name: 'Figure' }).click();
  const box = page.getByRole('dialog', { name: 'Insert a figure' });
  await box.getByRole('combobox', { name: /^Picture/ }).selectOption('50%.png');
  await box.getByLabel('Caption').fill('Half');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toHaveText(
    "LaTeX cannot use this picture's name. Rename it first.",
  );
  await expect(source(other)).not.toContainText('50%.png');
  await expect(page.locator(VISUAL).getByRole('group', { name: 'Figure' })).toHaveCount(1);
});

/** A paper with MAIN and these pictures, open in the editor, and a second page on its source. */
async function paperWith(browser: Browser, who: string, pictures: string[]) {
  const { page, email } = await person(browser, who);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Pictures ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      ...pictures.map((path) => ({ path, bytes: PNG })),
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  const other = await page.context().newPage();
  await other.goto(page.url());
  await showSource(other);
  await expect(source(other)).toContainText('Text after the figure.');
  return { page, other };
}
const openFigure = async (page: Page) => {
  await clickAfter(page, VISUAL, 'Text before');
  await page.getByRole('group', { name: 'Edit' }).getByRole('button', { name: 'Figure' }).click();
  return page.getByRole('dialog', { name: 'Insert a figure' });
};
const figuresIn = async (other: Page) =>
  (await sourceText(other)).split('\\begin{figure}').length - 1;

test('the figure window does not say there are no pictures while they load or if they fail', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { page, other } = await paperWith(browser, 'figure-loading', ['figures/dot.png']);
  // Held until the test lets the answer go.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/pictures', async (route) => {
    await held;
    await route.continue();
  });
  const box = await openFigure(page);
  const insert = box.getByRole('button', { name: 'Insert' });
  await expect(box.getByRole('combobox', { name: /^Picture/ }).getByRole('option')).toHaveText([
    'Loading pictures…',
  ]);
  await expect(box.getByText('no pictures yet')).toHaveCount(0);
  await expect(insert).toBeDisabled();
  // A press does nothing but say why, and nothing is written.
  await box.getByLabel('Caption').fill('Early');
  // aria-disabled keeps it pressable, so that the press is answered.
  await insert.click({ force: true });
  await expect(box.getByRole('alert')).toContainText('still loading');
  release();
  await expect(box.getByRole('combobox', { name: /^Picture/ }).getByRole('option')).toHaveText([
    'figures/dot.png',
    'No picture yet',
  ]);
  await expect(insert).toBeEnabled();
  await page.unroute('**/pictures');
  expect(await figuresIn(other)).toBe(1);
  await box.getByRole('button', { name: 'Cancel' }).click();

  // A failure is said, and is not "no pictures yet".
  await page.route('**/pictures', (route) => route.fulfill({ status: 500, body: 'no' }));
  const failed = await openFigure(page);
  await expect(failed.getByText('Could not load the pictures.')).toBeVisible();
  await expect(failed.getByText('no pictures yet')).toHaveCount(0);
  await expect(failed.getByRole('button', { name: 'Insert' })).toBeDisabled();
  // Retry asks again, and this time the answer comes.
  await page.unroute('**/pictures');
  await failed.getByRole('button', { name: 'Retry' }).click();
  await expect(failed.getByRole('combobox', { name: /^Picture/ }).getByRole('option')).toHaveText([
    'figures/dot.png',
    'No picture yet',
  ]);
  await expect(failed.getByText('Could not load the pictures.')).toHaveCount(0);
  await expect(failed.getByRole('button', { name: 'Insert' })).toBeEnabled();
  expect(await figuresIn(other)).toBe(1);
});

test('with two pictures none is chosen for the person, and a float goes after its paragraph', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { page, other } = await paperWith(browser, 'figure-choose', [
    'figures/dot.png',
    'figures/dot2.png',
  ]);
  const box = await openFigure(page);
  const picture = box.getByRole('combobox', { name: /^Picture/ });
  await expect(picture.getByRole('option')).toHaveText([
    'Choose a picture…',
    'figures/dot.png',
    'figures/dot2.png',
    'No picture yet',
  ]);
  await box.getByLabel('Caption').fill('Chosen late');
  await box.getByRole('button', { name: 'Insert' }).click();
  await expect(box.getByRole('alert')).toContainText('Choose a picture first');
  expect(await figuresIn(other)).toBe(1);
  // The choice is the person's, and a window opened again starts from nothing.
  await picture.selectOption('figures/dot2.png');
  await box.getByRole('button', { name: 'Cancel' }).click();
  const again = await openFigure(page);
  await expect(again.getByRole('combobox', { name: /^Picture/ })).toHaveValue('?');
  await expect(again.getByLabel('Caption')).toHaveValue('');
  await again.getByRole('combobox', { name: /^Picture/ }).selectOption('figures/dot2.png');
  await again.getByLabel('Caption').fill('Chosen late');
  await again.getByRole('button', { name: 'Insert' }).click();
  await expect(again).toBeHidden({ timeout: 15_000 });
  // The caret was in the middle of "Text before the figure.": the paragraph is whole and the
  // new figure follows it, in blank lines.
  await expect.poll(() => figuresIn(other)).toBe(2);
  const text = await sourceText(other);
  expect(text).toContain('Text before the figure.');
  expect(text).toMatch(
    /Text before the figure\.\\begin\{figure\}\[t\]\s*\\centering\s*\\includegraphics\[width=\\linewidth\]\{figures\/dot2\.png\}/,
  );
  // Blank lines on both sides: the source view shows each as a line of its own. The other
  // person's view takes the change from sync, so its lines are read until they have settled.
  const around = async () => {
    const lines = await source(other).locator('.cm-line').allTextContents();
    const at = lines.indexOf('Text before the figure.');
    const end = lines.indexOf('\\end{figure}', at);
    return [lines.slice(at, at + 3), lines.slice(end, end + 3)];
  };
  await expect.poll(around).toEqual([
    ['Text before the figure.', '', '\\begin{figure}[t]'],
    ['\\end{figure}', '', '\\begin{figure}[t]'],
  ]);
});
