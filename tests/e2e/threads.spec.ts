// Comments about a stretch of text: started by a reviewer who cannot edit, answered by the
// owner, shown in the text, and kept when the text is deleted. Needs the services and the sync
// server.
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { emailedLink, person, run, selectWord, showSource, signIn, typingSaved } from './helpers';

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

test('a reviewer starts a thread, the owner answers, and it outlives the text it was about', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await person(browser, 'thread-owner');
  const reviewer = await person(browser, 'thread-reviewer');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Threads ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByLabel('Their email address').fill(reviewer.email);
  await owner.page.getByLabel('Their role').selectOption('reviewer');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(reviewer.email);
  await reviewer.page.goto(await emailedLink(reviewer.email, '/invitations/'));
  await signIn(reviewer.page, reviewer.email);
  await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(reviewer.page.getByText('You are a reviewer')).toBeVisible();

  // The reviewer cannot type into the paper, but can select words in it and comment on them.
  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  const theirs = reviewer.page.getByRole('region', { name: 'Comments' });
  await expect(theirs.getByText('No open threads on this file.')).toBeVisible();
  await theirs.getByRole('button', { name: 'Comment on the selected text' }).click();
  await expect(theirs.getByText('Select the text the comment is about first.')).toBeVisible();
  await selectWord(reviewer.page, VISUAL, 'forty');
  await theirs.getByRole('button', { name: 'Comment on the selected text' }).click();
  await expect(theirs.locator('blockquote')).toHaveText('forty');
  await theirs.getByLabel('Comment', { exact: true }).fill('Is that the median or the tail?');
  await theirs.getByRole('checkbox', { name: owner.email }).check();
  await theirs.getByRole('button', { name: 'Start thread' }).click();
  const thread = (page: typeof owner.page) =>
    page.getByRole('article', { name: 'Thread on “forty”' });
  await expect(thread(reviewer.page)).toContainText('Is that the median or the tail?');
  await expect(thread(reviewer.page)).toContainText(`to ${owner.email}`);

  // The words are marked in the text, where the reviewer reads it.
  await expect(reviewer.page.locator(`${VISUAL} .thread-mark`)).toHaveText('forty');

  // The owner is told by email where to look, and not what was said.
  const link = await emailedLink(owner.email, '#comments');
  await owner.page.goto(link);
  await expect(thread(owner.page)).toContainText('Is that the median or the tail?');
  // "Show in the text" selects the words the thread is about.
  await thread(owner.page).getByRole('button', { name: 'Show in the text' }).click();
  await expect.poll(() => owner.page.evaluate(() => getSelection()!.toString())).toBe('forty');
  // Who can be mentioned is listed once a reply is begun, and not under every thread before:
  // with many threads and many people that was a box for each person under each thread.
  await expect(thread(owner.page).getByRole('checkbox')).toHaveCount(0);
  await thread(owner.page).getByLabel('Reply about “forty”').fill('The 95th percentile.');
  await expect(thread(owner.page).getByRole('checkbox', { name: reviewer.email })).toBeVisible();
  await thread(owner.page).getByRole('button', { name: 'Reply' }).click();
  // The reviewer sees the answer without asking.
  await expect(thread(reviewer.page)).toContainText('The 95th percentile.', { timeout: 15_000 });

  // Marked in the source view too, and on the paper's page the thread is listed.
  await showSource(owner.page);
  await expect(owner.page.locator('.editor .cm-content .thread-mark')).toHaveText('forty');

  // The owner changes the word: the thread says its text has changed, and how it reads now.
  await selectWord(owner.page, '.editor .cm-content', 'forty');
  // Inside the word. (Typed against either end, it would stay outside the thread's text.)
  await owner.page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 3; i++) await owner.page.keyboard.press('ArrowRight');
  await owner.page.keyboard.type('-');
  await typingSaved(owner.page);
  await expect(thread(owner.page)).toContainText('Changed since. It now reads: for-ty', {
    timeout: 15_000,
  });
  // The mark has grown with the word, without waiting for the server.
  await expect(owner.page.locator('.editor .cm-content .thread-mark')).toHaveText('for-ty');

  // Then cuts the sentence. The thread is kept, with the words it was about and their place.
  await selectWord(owner.page, '.editor .cm-content', 'Latency');
  await owner.page.keyboard.press('Home');
  await owner.page.keyboard.press('Shift+End');
  await owner.page.keyboard.press('Backspace');
  await typingSaved(owner.page);
  await expect(thread(owner.page)).toContainText('This text has been deleted.', {
    timeout: 15_000,
  });
  await expect(thread(owner.page)).toContainText('Latency stays below forty');
  await expect(thread(owner.page).getByRole('button', { name: 'Show in the text' })).toHaveCount(0);
  await expect(thread(owner.page)).toContainText('Is that the median or the tail?');

  await expect(owner.page.locator('.editor .thread-mark')).toHaveCount(0);

  // The words it was started on are written again, once: the thread can be attached to them,
  // and is marked there.
  await thread(owner.page).getByRole('button', { name: 'Attach to the same words again' }).click();
  await expect(owner.page.getByRole('region', { name: 'Comments' })).toContainText(
    'Those words are not in the file now.',
  );
  await owner.page.locator('.editor .cm-content').click();
  await owner.page.keyboard.press('ControlOrMeta+End');
  await owner.page.keyboard.type('% It was under forty, we think.');
  await typingSaved(owner.page);
  await thread(owner.page).getByRole('button', { name: 'Attach to the same words again' }).click();
  await expect(thread(owner.page)).not.toContainText('This text has been deleted.');
  await expect(owner.page.locator('.editor .cm-content .thread-mark')).toHaveText('forty');
  // The paper's page lists what is still open.
  const paperPage = await owner.page.context().newPage();
  await paperPage.goto(owner.page.url().replace(/\/files\/.*$/, ''));
  await expect(paperPage.getByRole('listitem').filter({ hasText: 'the latest by' })).toContainText(
    `main.tex: forty. 2 comments, the latest by ${owner.email}.`,
  );

  // The paper is downloaded with its review and imported again: the thread arrives with it,
  // under the names of the people who wrote it.
  const [download] = await Promise.all([
    paperPage.waitForEvent('download'),
    paperPage.getByRole('link', { name: 'ZIP with review data' }).click(),
  ]);
  await paperPage.goto('/projects');
  await paperPage
    .getByLabel('Or import a ZIP of a LaTeX project')
    .setInputFiles(await download.path());
  await paperPage.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(
    paperPage.getByText(/Review data came with the archive: 1 thread and 0 proposed changes/),
  ).toBeVisible();
  await expect(paperPage.getByRole('listitem').filter({ hasText: 'the latest by' })).toContainText(
    `main.tex: forty. 2 comments, the latest by ${owner.email}.`,
  );
  await paperPage.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(paperPage.getByRole('article', { name: 'Thread on “forty”' })).toContainText(
    reviewer.email,
  );
  await paperPage.close();

  // Resolved, it moves out of the way but is not gone.
  await thread(owner.page).getByRole('button', { name: 'Resolve' }).click();
  const mine = owner.page.getByRole('region', { name: 'Comments' });
  await expect(mine.getByText('No open threads on this file.')).toBeVisible();
  await mine.getByText('Resolved (1)').click();
  await expect(thread(owner.page)).toContainText('The 95th percentile.');
  await expect(thread(owner.page).getByRole('button', { name: 'Open again' })).toBeVisible();
});
