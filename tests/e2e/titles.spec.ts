// Every page has a title that says where the person is (WCAG 2.4.2): a screen reader says it
// first when a page opens. And a paper's name is in a title only for someone who may see the paper.
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { emailedLink, person, run, signIn } from './helpers';

const MAIN = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
const CSV = 'day,latency (ms)\n2024-03-01,9\n2024-03-02,38\n';
const NOTHING = 'Nothing here — PaperWeave';

test('each page is titled for where it is, and an outsider is not told a paper’s name', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'titles-owner');
  const guest = await person(browser, 'titles-guest');
  const outsider = await person(browser, 'titles-outsider');
  const { page } = owner;
  const name = `Titles ${run}`;

  await page.goto('/sign-in');
  await expect(page).toHaveTitle('Sign in — PaperWeave');
  await signIn(page, owner.email);
  await expect(page).toHaveTitle('Papers — PaperWeave');

  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `${name}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'data/latency.csv', bytes: Buffer.from(CSV) },
    ]),
  );
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const paper = page.url();
  await expect(page).toHaveTitle(`${name} — PaperWeave`);

  // The file: its path, then the paper.
  const mainHref = await page.getByRole('link', { name: 'main.tex' }).first().getAttribute('href');
  await page.goto(mainHref!);
  await expect(page).toHaveTitle(`main.tex · ${name} — PaperWeave`);
  const fileUrl = page.url();

  await page.goto(`${fileUrl}/rename?to=other.tex`);
  await expect(page).toHaveTitle('Rename a file — PaperWeave');
  await page.goto(`${paper}/labels/rename?from=a&to=b`);
  await expect(page).toHaveTitle('Rename a label — PaperWeave');
  await page.goto(`${paper}/submit`);
  await expect(page).toHaveTitle(`Check before submitting · ${name} — PaperWeave`);

  await page.goto(paper);
  await page.getByRole('link', { name: 'Describe it' }).click();
  await expect(page.getByRole('button', { name: 'Approve this description' })).toBeVisible();
  await expect(page).toHaveTitle(`Describe a data file · ${name} — PaperWeave`);
  const dataUrl = page.url();
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await page.getByRole('link', { name: /New chart from/ }).click();
  await expect(page.getByRole('heading', { name: 'New chart' })).toBeVisible();
  await expect(page).toHaveTitle(`New chart · ${name} — PaperWeave`);
  const chartUrl = page.url();

  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('First');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');
  await page.goto(`${paper}/revisions/1/diff/1`);
  await expect(page).toHaveTitle('Revision 1 to revision 1 — PaperWeave');

  await page.goto('/no-such-page');
  await expect(page).toHaveTitle(NOTHING);

  // An invitation says which paper it is to, to the person it is for and to no one else.
  await page.goto(paper);
  await page.getByLabel('Their email address').fill(guest.email);
  await page.getByLabel('Their role').selectOption('reviewer');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText(`Invitation sent to ${guest.email}`);
  const invitation = await emailedLink(guest.email, '/invitations/');
  await outsider.page.goto(invitation);
  await signIn(outsider.page, outsider.email);
  await expect(outsider.page.getByRole('heading', { name: /for someone else/ })).toBeVisible();
  await expect(outsider.page).toHaveTitle('Invitation for someone else — PaperWeave');
  await guest.page.goto(invitation);
  await signIn(guest.page, guest.email);
  await expect(guest.page).toHaveTitle(`Invitation to ${name} — PaperWeave`);

  // Someone who is not on the paper gets the page for what is not there, with its title, from
  // every address that would name the paper, a file, a chart or a data file.
  for (const url of [paper, fileUrl, `${paper}/submit`, dataUrl, chartUrl]) {
    await outsider.page.goto(url);
    await expect(outsider.page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
    await expect(outsider.page).toHaveTitle(NOTHING);
    expect(await outsider.page.title(), url).not.toContain(name);
    expect(await outsider.page.content(), url).not.toContain(name);
  }
});
