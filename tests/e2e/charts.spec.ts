// A chart is drawn from a described data file, kept in the paper, and marked out of date when
// the data changes. Needs the services, the sync server and the worker.
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { clickAfter, person, run, showSource, signIn, typingSaved } from './helpers';

const VISUAL = '.editor .visual .ProseMirror';

const CSV =
  'day,latency (ms),site\n2024-03-01,9,Lab\n2024-03-02,NA,Lab\n2024-03-03,38,Field\n2024-03-04,41,Field\n';
const MAIN = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';

test('a chart is drawn from approved data and is out of date once the data changes', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'chart-owner');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Charts ${run}.zip`);
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
  await expect(page.getByRole('heading', { name: 'Data' })).toBeVisible();
  const paper = page.url();
  const data = page.getByRole('listitem').filter({ hasText: 'data/latency.csv:' });

  // No chart from a file nobody has described.
  await expect(page.getByRole('link', { name: /New chart/ })).toHaveCount(0);
  await data.getByRole('link', { name: 'Describe it' }).click();
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await data.getByRole('link', { name: 'New chart from data/latency.csv' }).click();

  await expect(page.getByRole('heading', { name: 'New chart' })).toBeVisible();
  // A name the chart's files could not take is caught in the form, before anything is sent.
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('Latency by day');
  expect(await name.evaluate((el: HTMLInputElement) => el.validity.patternMismatch)).toBe(true);
  await page.getByRole('button', { name: 'Draw the chart' }).click();
  await expect(page).toHaveURL(/charts\/new\?data=[0-9a-f-]+$/);

  // A chart that cannot be drawn is refused with the reason, and the form is still there.
  await page.getByLabel('Name', { exact: true }).fill('latency');
  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('bar');
  await page.getByRole('combobox', { name: 'Along the bottom', exact: true }).selectOption('site');
  await page.getByRole('button', { name: 'Draw the chart' }).click();
  await expect(page.locator('main [role=alert]')).toContainText(
    'Several rows share a value of "site".',
  );

  await page.getByLabel('Name', { exact: true }).fill('latency');
  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('line');
  await page.getByRole('combobox', { name: 'Along the bottom', exact: true }).selectOption('day');
  await page.getByLabel('Where a line has no value').selectOption('join');
  await page.getByRole('button', { name: 'Draw the chart' }).click();
  // The page looks again by itself until the worker has drawn it.
  const picture = page.getByRole('img', { name: 'Line chart of latency (ms) against day.' });
  await expect(picture).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(300);
  await expect(page.getByText('1 row with no value was left out.')).toBeVisible();
  await expect(page.getByText('Out of date.')).toHaveCount(0);
  const chart = page.url();

  // Its files are files of the paper.
  await page.goto(paper);
  await expect(page.getByText('charts/latency.pdf')).toBeVisible();
  await expect(page.getByText('charts/latency.png')).toBeVisible();
  const listed = page.getByRole('listitem').filter({ hasText: 'Line chart of latency' });
  await expect(listed).toContainText('Drawn 20');

  // One of them is deleted by hand. The chart does not go on saying it is drawn and showing a
  // picture that is not there: it says its files have gone, and drawing it again brings them back.
  await page.getByRole('button', { name: 'Delete charts/latency.png' }).click();
  await expect(page.getByRole('status')).toContainText('Deleted charts/latency.png.');
  await expect(listed).toContainText('Its files are no longer in the paper: draw it again.');
  await page.goto(chart);
  await expect(page.getByRole('status')).toContainText('Not in the paper.');
  await expect(picture).toHaveCount(0);
  await page.getByRole('button', { name: 'Draw it again' }).click();
  await expect(page.getByText('Not in the paper.')).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(300);
  await page.goto(paper);
  await expect(page.getByText('charts/latency.png')).toBeVisible();
  await expect(listed).toContainText('Drawn 20');

  // Its author gives it a caption. The record of how it was made is on its page.
  await page.goto(chart);
  await page.getByLabel(/^Caption/).fill('Latency over four days.');
  await page.getByRole('button', { name: 'Draw it again' }).click();
  await expect(page.getByText('Waiting to be drawn…')).toHaveCount(0, { timeout: 30_000 });
  const made = page.getByRole('listitem').filter({ hasText: 'from data/latency.csv version' });
  await expect(made).toHaveCount(1);
  await expect(made).toContainText('1 row with no value left out (no value: NA)');

  // Put into the paper as a figure: the chart is offered once, and brings its caption and its
  // description with it.
  await page.goto(paper);
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  await clickAfter(page, VISUAL, 'Hello');
  await page.getByRole('group', { name: 'Edit' }).getByRole('button', { name: 'Figure' }).click();
  const box = page.getByRole('dialog', { name: 'Insert a figure' });
  await expect(box.getByLabel('Picture').getByRole('option')).toHaveText([
    'charts/latency.pdf',
    'None yet',
  ]);
  await expect(box.getByLabel('Caption')).toHaveValue('Latency over four days.');
  await expect(box.getByLabel(/^Description/)).toHaveValue(
    'Line chart of latency (ms) against day.',
  );
  await box.getByRole('button', { name: 'Insert' }).click();
  // The editor gives the server eight seconds to answer. If the edit is refused, the window
  // says why, and so does this.
  await expect(async () => {
    expect(await box.getByRole('alert').allTextContents()).toEqual([]);
    await expect(box).toBeHidden({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  // The editor shows the chart, though what the paper includes is the PDF.
  const figure = page.locator(VISUAL).getByRole('group', { name: 'Figure' });
  await expect(figure.locator('img')).toHaveAttribute(
    'alt',
    'Line chart of latency (ms) against day.',
  );
  await expect
    .poll(() => figure.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(300);
  await showSource(page);
  await expect(page.locator('.editor .cm-content')).toContainText(
    '\\includegraphics[width=\\linewidth,alt={Line chart of latency (ms) against day.}]{charts/latency.pdf}',
  );

  // The data is edited: the chart is of an older version, and the paper says so.
  await page.getByRole('link', { name: 'data/latency.csv' }).first().click();
  await expect(page.getByRole('region', { name: 'Editor for data/latency.csv' })).toBeVisible();
  // Not before the file is there. This test once typed into the editor while it was still
  // empty: the row landed at the top, became the heading row, and no column was a number.
  await expect(page.locator('.editor .cm-content')).toContainText('2024-03-04,41,Field');
  await page.locator('.editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('2024-03-05,44,Field\n');
  await typingSaved(page);
  await page.goto(paper);
  await expect(listed).toContainText('Out of date: its data has changed since it was drawn.');

  // It is not redrawn from data nobody has looked at.
  await page.goto(chart);
  await expect(page.getByRole('status')).toContainText('Out of date.');
  await page.getByRole('button', { name: 'Draw it again' }).click();
  await expect(page.locator('main [role=alert]')).toContainText(
    'has changed since its description was approved',
  );
  await page.getByRole('link', { name: 'Look at the data again' }).click();
  await page.getByRole('button', { name: 'Approve this description' }).click();
  // Not before the approval has landed: leaving the page at once would cut it short.
  await expect(page.getByRole('status')).toHaveText('Description approved.');
  // What was approved is what was there before, with one more row: the columns are as they were.
  await expect(data).toContainText('day (date), latency (ms) in ms (number), site (text)');
  await page.goto(chart);
  await expect(page.getByRole('combobox', { name: 'Up the side' })).toHaveValue('latency (ms)');
  await page.getByRole('button', { name: 'Draw it again' }).click();
  // Drawn again from the new version: the row that was added is among those drawn.
  // Checked against the whole page, so that a failure here shows what the page said instead.
  // (Seen once in a full run, not since: the chart was still out of date after this click.)
  await expect(page.locator('main')).not.toContainText('Out of date.', { timeout: 30_000 });
  await expect(page.getByText('Waiting to be drawn…')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('main [role=alert]')).toHaveCount(0);
  await expect(picture).toBeVisible();
});
