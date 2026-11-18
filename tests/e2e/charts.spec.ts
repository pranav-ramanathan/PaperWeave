// A chart is drawn from a described data file, kept in the paper, and marked out of date when
// the data changes. Needs the services, the sync server and the worker.
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { person, run, signIn, typingSaved } from './helpers';

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

  // A chart that cannot be drawn is refused with the reason, and the form is still there.
  await expect(page.getByRole('heading', { name: 'New chart' })).toBeVisible();
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

  // The data is edited: the chart is of an older version, and the paper says so.
  await page.getByRole('link', { name: 'data/latency.csv' }).first().click();
  await expect(page.getByRole('region', { name: 'Editor for data/latency.csv' })).toBeVisible();
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
  await page.goto(chart);
  await page.getByRole('button', { name: 'Draw it again' }).click();
  await expect(page.getByText('Waiting to be drawn…')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('Out of date.')).toHaveCount(0);
  await expect(picture).toBeVisible();
});
