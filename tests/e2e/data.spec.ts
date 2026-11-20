// A CSV file becomes data when its author has said what it holds. Needs the services and the
// sync server.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { person, run, signIn, typingSaved } from './helpers';

const CSV =
  'site,writers,"latency, p95 (ms)",note\n"Lab, north",1,9,\n"Lab, north",3,NA,"said ""slow"""\nField,5,38,\nField,8,n/a,retry\n';
const MAIN = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
const downloaded = async (page: Page) => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  return (await readZip(readFileSync(await download.path()))).entries;
};

test('a data file is described by its author, and leaves with the paper only if they say so', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'data-owner');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Data ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'data/latency.csv', bytes: Buffer.from(CSV) },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  const listed = page.getByRole('listitem').filter({ hasText: 'data/latency.csv' });
  await expect(listed).toContainText('not described yet.');

  // The guess: a quoted name with a comma is one column, its unit is read from its name, and
  // the gaps are counted however they were spelt.
  await listed.getByRole('link', { name: 'Describe it' }).click();
  await expect(page.getByText('4 rows, 4 columns.')).toBeVisible();
  const column = (name: string) => page.getByRole('row', { name: new RegExp(`^${name}`) });
  await expect(column('latency, p95')).toContainText('9, 38');
  await expect(column('latency, p95').getByRole('cell').nth(1)).toHaveText('2');
  await expect(page.getByLabel('What latency, p95 (ms) holds')).toHaveValue('number');
  await expect(page.getByLabel('Unit of latency, p95 (ms)')).toHaveValue('ms');
  await expect(page.getByLabel('What site holds')).toHaveValue('text');

  // Say that "n/a" is a real value: the description is refused, naming the row that does not fit.
  await page.getByRole('checkbox', { name: 'n/a' }).uncheck();
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await expect(page.locator('main [role=alert]')).toContainText(
    '"latency, p95 (ms)", row 5: "n/a" is not a number.',
  );
  // Put right, with a unit and a note on where the data came from.
  await page.getByLabel('Unit of writers').fill('people');
  await page.getByLabel('Where the data came from').fill('Measured by us, March 2024.');
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await expect(page.getByRole('status')).toHaveText('Description approved.');
  await expect(listed).toContainText('writers in people (number)');
  await expect(listed).toContainText('latency, p95 (ms) in ms (number)');
  await expect(listed).toContainText(`by ${email}. Not included in downloads.`);

  // The paper leaves without the data, until its author says otherwise, and the page says so.
  const held = page.getByText(
    'Not in these downloads: data/latency.csv (marked as data to keep back).',
  );
  await expect(held).toBeVisible();
  expect((await downloaded(page)).map((e) => e.path).sort()).toEqual(['main.tex']);
  await listed.getByRole('link', { name: 'See or change its description' }).click();
  // What was approved is what is shown.
  await expect(page.getByLabel('Unit of writers')).toHaveValue('people');
  await expect(page.getByLabel('Where the data came from')).toHaveValue(
    'Measured by us, March 2024.',
  );
  // A note of 2000 characters, ten of them line breaks, is as long as the field allows: the
  // browser sends each break as two characters, and the server must not count them so.
  const long = Array.from({ length: 11 }, (_, i) => 'x'.repeat(i < 10 ? 181 : 180)).join('\n');
  expect(long).toHaveLength(2000);
  await page.getByLabel('Where the data came from').fill(long);
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await expect(page.getByRole('status')).toHaveText('Description approved.');
  await page.getByRole('link', { name: 'See or change its description' }).click();
  expect(await page.getByLabel('Where the data came from').inputValue()).toBe(long);
  await page.getByLabel('Where the data came from').fill('Measured by us, March 2024.');
  await page.getByRole('checkbox', { name: /Include this file in downloads/ }).check();
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await expect(listed).toContainText('Included in downloads.');
  await expect(held).toHaveCount(0);
  const files = await downloaded(page);
  expect(files.map((e) => e.path).sort()).toEqual(['data/latency.csv', 'main.tex']);
  expect(Buffer.from(files.find((e) => e.path === 'data/latency.csv')!.bytes).toString()).toBe(CSV);

  // The file is edited. Its description is now of an older version, and the page says so.
  await page.getByRole('link', { name: 'data/latency.csv' }).first().click();
  await expect(page.getByRole('region', { name: 'Editor for data/latency.csv' })).toBeVisible();
  // Not before the file is there: until it is, the editor takes no typing.
  await expect(
    page.getByRole('region', { name: 'Editor for data/latency.csv' }).getByRole('status'),
  ).toHaveText('All edits saved.');
  await page.locator('.editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Field,13,71,\n');
  await typingSaved(page);
  await page.goto(paper);
  await expect(listed).toContainText('The file has changed since: its charts are out of date.');
  await listed.getByRole('link', { name: 'Look at it again' }).click();
  await expect(page.getByText('5 rows, 4 columns.')).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'The file has changed since its description was approved',
  );
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await expect(listed).not.toContainText('The file has changed since');
});

test('data held from downloads that the paper reads is named beside the downloads, and stops a submission', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'data-held');
  const main =
    '\\documentclass{article}\n\\usepackage{pgfplotstable}\n\\begin{document}\n\\pgfplotstableread{data.csv}\\table\n\\end{document}\n';
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Held ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(main) },
      { path: 'data.csv', bytes: Buffer.from('day,latency\n1,9\n2,38\n') },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  const listed = page.getByRole('listitem').filter({ hasText: 'data.csv' });
  await listed.getByRole('link', { name: 'Describe it' }).click();
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await expect(page.getByRole('status')).toHaveText('Description approved.');
  await page.goto(paper);

  const sentence =
    'The paper reads data.csv, which is not included in downloads: the ZIP would not build without it. Include it in downloads, or draw the chart here and include the drawing instead.';
  await expect(listed).toContainText(`Not included in downloads. ${sentence}`);
  await expect(
    page.getByText('Not in these downloads: data.csv (marked as data to keep back).'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Check before submitting' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: sentence })).toBeVisible();
  await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0);

  // Included, the sentence goes, and so does the line.
  await page.goto(paper);
  await listed.getByRole('link', { name: 'See or change its description' }).click();
  await page.getByRole('checkbox', { name: /Include this file in downloads/ }).check();
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await expect(listed).toContainText('Included in downloads.');
  await expect(listed).not.toContainText('is not included in downloads');
  await expect(page.getByText('Not in these downloads')).toHaveCount(0);
});
