// What an editor left open asks of the server when nothing is happening, and that what another
// person does still reaches it soon. Needs the services, the sync server and the build worker.
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { emailedLink, person, run, selectWord, signIn } from './helpers';

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Latency stays below forty milliseconds for most edits.',
  '',
  'Nothing else is claimed here.',
  '\\end{document}',
  '',
].join('\n');
const VISUAL = '.editor .visual .ProseMirror';

async function paperWith(browser: Parameters<typeof person>[0], who: string, role?: 'reviewer') {
  const owner = await person(browser, `${who}-owner`);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Idle ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  let reviewer: Awaited<ReturnType<typeof person>> | undefined;
  if (role) {
    reviewer = await person(browser, `${who}-reviewer`);
    await owner.page.getByLabel('Their email address').fill(reviewer.email);
    await owner.page.getByLabel('Their role').selectOption(role);
    await owner.page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(owner.page.getByRole('status')).toContainText(reviewer.email);
    await reviewer.page.goto(await emailedLink(reviewer.email, '/invitations/'));
    await signIn(reviewer.page, reviewer.email);
    await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
    await expect(reviewer.page.getByText('You are a reviewer')).toBeVisible();
  }
  return { owner, reviewer };
}

test('an editor left open and shown asks the server for little', async ({ browser }) => {
  test.setTimeout(180_000);
  const { owner } = await paperWith(browser, 'idle');
  const page = owner.page;
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.getByRole('region', { name: 'Comments' })).toBeVisible();
  // Let the first build finish, and the polls settle down after it.
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });
  await page.waitForTimeout(8000);
  const asked: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/projects/')) asked.push(`${r.method()} ${u.pathname}`);
  });
  await page.waitForTimeout(30_000);
  const count = (re: RegExp) => asked.filter((a) => re.test(a)).length;
  // Every five seconds how the builds stand: six. The comments and proposals are not asked for
  // at all while nothing has changed. (The first version asked for about 27.)
  expect(count(/\/builds$/), asked.join('\n')).toBeLessThanOrEqual(8);
  expect(count(/\/(threads|proposals)$/), asked.join('\n')).toBe(0);
  expect(asked.length, asked.join('\n')).toBeLessThanOrEqual(10);
});

test('what another person comments reaches an open editor within the poll', async ({ browser }) => {
  test.setTimeout(180_000);
  const { owner, reviewer } = await paperWith(browser, 'noticed', 'reviewer');
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  const mine = owner.page.getByRole('region', { name: 'Comments' });
  await expect(mine.getByText('No open threads on this file.')).toBeVisible();
  await reviewer!.page.getByRole('link', { name: 'main.tex' }).first().click();
  const theirs = reviewer!.page.getByRole('region', { name: 'Comments' });
  await selectWord(reviewer!.page, VISUAL, 'forty');
  await theirs.getByRole('button', { name: 'Comment on the selected text' }).click();
  await theirs.getByLabel('Comment', { exact: true }).fill('Median or tail?');
  await theirs.getByRole('button', { name: 'Start thread' }).click();
  await expect(theirs.getByRole('article', { name: 'Thread on “forty”' })).toBeVisible();
  // The owner has not touched the page, and sees it.
  await expect(mine.getByRole('article', { name: 'Thread on “forty”' })).toContainText(
    'Median or tail?',
    { timeout: 10_000 },
  );
  // A proposal as well.
  const changes = reviewer!.page.getByRole('region', { name: 'Proposed changes' });
  await changes.getByRole('button', { name: 'Propose a change here' }).click();
  await changes.getByLabel('Replace it with').fill('thirty');
  await changes.getByRole('button', { name: 'Propose', exact: true }).click();
  await expect(
    owner.page.getByRole('region', { name: 'Proposed changes' }).getByRole('article'),
  ).toContainText('Proposed: thirty', { timeout: 10_000 });
});

test('a tab behind others catches up on comments when it is shown again', async ({ browser }) => {
  test.setTimeout(180_000);
  const { owner, reviewer } = await paperWith(browser, 'behind', 'reviewer');
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  const mine = owner.page.getByRole('region', { name: 'Comments' });
  await expect(mine.getByText('No open threads on this file.')).toBeVisible();
  const show = (hidden: boolean) =>
    owner.page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await show(true);
  await reviewer!.page.getByRole('link', { name: 'main.tex' }).first().click();
  const theirs = reviewer!.page.getByRole('region', { name: 'Comments' });
  await selectWord(reviewer!.page, VISUAL, 'forty');
  await theirs.getByRole('button', { name: 'Comment on the selected text' }).click();
  await theirs.getByLabel('Comment', { exact: true }).fill('Median or tail?');
  await theirs.getByRole('button', { name: 'Start thread' }).click();
  await expect(theirs.getByRole('article', { name: 'Thread on “forty”' })).toBeVisible();
  // Nobody is looking at the owner's tab: it has not asked, and shows nothing new.
  await owner.page.waitForTimeout(7000);
  await expect(mine.getByText('No open threads on this file.')).toBeVisible();
  await show(false);
  await expect(mine.getByRole('article', { name: 'Thread on “forty”' })).toContainText(
    'Median or tail?',
    { timeout: 3000 },
  );
});
