// Comments about a stretch of text: started by a reviewer who cannot edit, answered by the
// owner, shown in the text, and kept when the text is deleted. Needs the services and the sync
// server.
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { connect } from '../../packages/server/src/db';
import {
  audit,
  emailedLink,
  MAIL,
  person,
  run,
  selectWord,
  showSource,
  signIn,
  typingSaved,
} from './helpers';

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
  // Pressed twice at once, it starts one thread.
  await theirs.getByRole('button', { name: 'Start thread' }).evaluate((b: HTMLButtonElement) => {
    b.click();
    b.click();
  });
  const thread = (page: typeof owner.page) =>
    page.getByRole('article', { name: 'Thread on “forty”' });
  await expect(thread(reviewer.page)).toHaveCount(1);
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
  await thread(owner.page).getByRole('button', { name: 'Open again' }).click();

  // A thread resolved by one person while another is part-way through a reply to it: the
  // reply is not thrown away. The thread stays where it was for its writer and says what
  // happened, and the reply can still be sent.
  await expect(thread(reviewer.page).getByRole('button', { name: 'Resolve' })).toBeVisible({
    timeout: 15_000,
  });
  await thread(reviewer.page).getByLabel('Reply about “forty”').fill('Thank you, that settles it.');
  await thread(owner.page).getByRole('button', { name: 'Resolve' }).click();
  await expect(thread(reviewer.page)).toContainText(
    'This thread was resolved while you were writing. Your reply can still be sent.',
    { timeout: 15_000 },
  );
  await expect(thread(reviewer.page).getByLabel('Reply about “forty”')).toHaveValue(
    'Thank you, that settles it.',
  );
  await audit(reviewer.page, 'a thread resolved under a reply being written');
  await thread(reviewer.page).getByRole('button', { name: 'Reply' }).click();
  // Sent, the thread goes where resolved threads go, with the reply in it.
  await expect(theirs.getByText('No open threads on this file.')).toBeVisible();
  await theirs.getByText('Resolved (1)').click();
  await expect(thread(reviewer.page)).toContainText('Thank you, that settles it.');
});

/** The texts of the mention emails sent to an address, once there are `count` of them. */
async function mentionMails(to: string, count: number): Promise<string[]> {
  for (let i = 0; i < 60; i++) {
    const found = await (
      await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${to} subject:mentioned`)}`)
    ).json();
    const texts: string[] = await Promise.all(
      (found.messages ?? []).map(
        async (m: { ID: string }) =>
          ((await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json()) as { Text: string }).Text,
      ),
    );
    if (texts.length >= count) return texts;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`fewer than ${count} mention emails reached ${to}`);
}

test('the link in a mention email opens the comment it is about, signed out or in, resolved or not', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'link-owner');
  const reviewer = await person(browser, 'link-reviewer');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Links ${run}.zip`);
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

  // A paper made before names were checked can have a line break in its name. What is in the
  // name must not become lines of the email.
  const projectId = owner.page.url().split('/projects/')[1].split(/[/?#]/)[0];
  const pool = connect(
    process.env.DATABASE_URL ?? 'postgres://paperweave:paperweave@localhost:5432/paperweave',
  );
  try {
    await pool.query('update projects set name = $2 where id = $1', [
      projectId,
      'Line one\nLine two\nBcc: someone@example.org',
    ]);
  } finally {
    await pool.end();
  }

  // The reviewer comments on two places, mentioning the owner each time, and resolves the second.
  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  const panel = reviewer.page.getByRole('region', { name: 'Comments' });
  for (const word of ['forty', 'edits']) {
    await selectWord(reviewer.page, VISUAL, word);
    await panel.getByRole('button', { name: 'Comment on the selected text' }).click();
    await panel.getByLabel('Comment', { exact: true }).fill(`About ${word}.`);
    await panel.getByRole('checkbox', { name: owner.email }).check();
    await panel.getByRole('button', { name: 'Start thread' }).click();
    await expect(reviewer.page.getByRole('article', { name: `Thread on “${word}”` })).toBeVisible();
  }
  await reviewer.page
    .getByRole('article', { name: 'Thread on “edits”' })
    .getByRole('button', { name: 'Resolve' })
    .click();
  await expect(panel.getByText('Resolved (1)')).toBeVisible();

  const texts = await mentionMails(owner.email, 2);
  const links = texts.map((t) => /https?:\/\/\S+/.exec(t)![0]);
  for (const t of texts) {
    // On one line, and with nothing of what was written.
    expect(t).toContain('on the paper "Line one Line two Bcc: someone@example.org"');
    expect(t).not.toMatch(/^Bcc:/m);
    expect(t).not.toContain('About ');
  }
  for (const l of links)
    expect(l).toMatch(/\/files\/[0-9a-f-]{36}\?thread=[0-9a-f-]{36}#comments$/);

  // Which link is which: the thread each names, found by opening the file as the reviewer.
  await panel.getByText('Resolved (1)').click();
  const resolvedId = await reviewer.page
    .getByRole('article', { name: 'Thread on “edits”' })
    .getAttribute('id')
    .then((id) => id!.replace('thread-', ''));
  const openId = await reviewer.page
    .getByRole('article', { name: 'Thread on “forty”' })
    .getAttribute('id')
    .then((id) => id!.replace('thread-', ''));
  const linkTo = (id: string) => links.find((l) => l.includes(`thread=${id}`))!;
  expect(linkTo(resolvedId)).toBeTruthy();
  expect(linkTo(openId)).toBeTruthy();

  const marked = (page: typeof owner.page, word: string) =>
    page.getByRole('article', { name: `Thread on “${word}”` });
  const seen = async (page: typeof owner.page, word: string, id: string) => {
    await expect(page).toHaveURL(new RegExp(`thread=${id}`));
    await expect(marked(page, word)).toHaveAttribute('aria-current', 'true', { timeout: 30_000 });
    await expect(marked(page, word)).toBeInViewport();
    await expect(marked(page, word)).toHaveCSS('outline-style', 'solid');
    // And only that one.
    await expect(page.locator('article[aria-current=true]')).toHaveCount(1);
  };

  // Signed out: the link goes through sign-in and arrives at the marked thread.
  const guest = await person(browser, 'link-owner');
  await guest.page.goto(linkTo(openId));
  await expect(guest.page).toHaveURL(/\/sign-in\?next=.*thread%3D/);
  await signIn(guest.page, owner.email);
  await seen(guest.page, 'forty', openId);

  // The resolved one: the list of resolved threads is opened for it.
  const resolved = await person(browser, 'link-owner');
  await resolved.page.goto(linkTo(resolvedId));
  await signIn(resolved.page, owner.email);
  await seen(resolved.page, 'edits', resolvedId);
  await expect(resolved.page.locator('details[open]')).toContainText('Resolved (1)');

  // Signed in already: the same, with no sign-in in between.
  await owner.page.goto(linkTo(openId));
  await seen(owner.page, 'forty', openId);
  await owner.page.goto(linkTo(resolvedId));
  await seen(owner.page, 'edits', resolvedId);
  await expect(owner.page.locator('details[open]')).toContainText('Resolved (1)');

  // A thread that is gone: the panel says so.
  await owner.page.goto(linkTo(openId).replace(openId, '00000000-0000-4000-8000-000000000000'));
  await expect(owner.page.getByRole('region', { name: 'Comments' })).toContainText(
    'The comment this link was about is no longer here.',
  );
  await expect(owner.page.locator('article[aria-current=true]')).toHaveCount(0);
});

test('a comment is changed by its author and deleted by its author or the owner, on both pages', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'change-owner');
  const reviewer = await person(browser, 'change-reviewer');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Changes ${run}.zip`);
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

  // The reviewer comments on a word; the owner answers.
  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  const theirs = reviewer.page.getByRole('region', { name: 'Comments' });
  await selectWord(reviewer.page, VISUAL, 'forty');
  await theirs.getByRole('button', { name: 'Comment on the selected text' }).click();
  await theirs.getByLabel('Comment', { exact: true }).fill('Is that the mean?');
  await theirs.getByRole('button', { name: 'Start thread' }).click();
  const thread = (page: typeof owner.page) =>
    page.getByRole('article', { name: 'Thread on “forty”' });
  const comment = (page: typeof owner.page, words: string) =>
    thread(page).locator('ol > li').filter({ hasText: words });
  await expect(reviewer.page.locator(`${VISUAL} .thread-mark`)).toHaveText('forty');
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(comment(owner.page, 'Is that the mean?')).toBeVisible({ timeout: 15_000 });
  await thread(owner.page).getByLabel('Reply about “forty”').fill('The tail.');
  await thread(owner.page).getByRole('button', { name: 'Reply' }).click();
  await expect(comment(reviewer.page, 'The tail.')).toBeVisible({ timeout: 15_000 });

  // Who is offered what: each person may change their own words; the owner may delete both.
  await expect(
    comment(reviewer.page, 'Is that the mean?').getByRole('button', { name: 'Change' }),
  ).toBeVisible();
  await expect(comment(reviewer.page, 'The tail.').getByRole('button')).toHaveCount(0);
  await expect(
    comment(owner.page, 'Is that the mean?').getByRole('button', { name: 'Change' }),
  ).toHaveCount(0);
  await expect(
    comment(owner.page, 'Is that the mean?').getByRole('button', { name: 'Delete' }),
  ).toBeVisible();
  await expect(
    comment(owner.page, 'The tail.').getByRole('button', { name: 'Change' }),
  ).toBeVisible();

  // The reviewer changes their comment with the keyboard alone; the owner sees it, marked.
  await comment(reviewer.page, 'Is that the mean?').getByRole('button', { name: 'Change' }).focus();
  await reviewer.page.keyboard.press('Enter');
  await expect(theirs.getByLabel('Your comment')).toBeFocused();
  await expect(theirs.getByLabel('Your comment')).toHaveValue('Is that the mean?');
  await reviewer.page.keyboard.press('ControlOrMeta+A');
  await reviewer.page.keyboard.type('Is that the median?');
  await audit(reviewer.page, 'a comment being changed');
  await reviewer.page.keyboard.press('Tab');
  await expect(theirs.getByRole('button', { name: 'Save' })).toBeFocused();
  await reviewer.page.keyboard.press('Enter');
  await expect(comment(reviewer.page, 'Is that the median?')).toContainText('(changed)');
  await expect(comment(owner.page, 'Is that the median?')).toContainText('(changed)', {
    timeout: 15_000,
  });
  await expect(comment(owner.page, 'The tail.')).not.toContainText('(changed)');

  // The owner resolves the thread while the reviewer has the form open: the form stays, with
  // the words in it, and they can still be saved.
  await comment(reviewer.page, 'Is that the median?')
    .getByRole('button', { name: 'Change' })
    .click();
  await theirs.getByLabel('Your comment').fill('Is that the median, then?');
  await thread(owner.page).getByRole('button', { name: 'Resolve' }).click();
  await expect(thread(reviewer.page)).toContainText(
    'This thread was resolved while you were changing a comment. What you wrote can still be saved.',
    { timeout: 15_000 },
  );
  await expect(theirs.getByLabel('Your comment')).toHaveValue('Is that the median, then?');
  await theirs.getByRole('button', { name: 'Save' }).click();
  await theirs.getByText('Resolved (1)').click();
  await expect(comment(reviewer.page, 'Is that the median, then?')).toBeVisible();
  await owner.page.getByRole('region', { name: 'Comments' }).getByText('Resolved (1)').click();
  await thread(owner.page).getByRole('button', { name: 'Open again' }).click();
  await expect(thread(reviewer.page).getByRole('button', { name: 'Resolve' })).toBeVisible({
    timeout: 15_000,
  });

  // The reviewer adds a reply and takes it back: asked once, kept if declined, gone on both pages.
  await thread(reviewer.page).getByLabel('Reply about “forty”').fill('Sorry, wrong thread.');
  await thread(reviewer.page).getByRole('button', { name: 'Reply' }).click();
  await expect(comment(owner.page, 'Sorry, wrong thread.')).toBeVisible({ timeout: 15_000 });
  const wrong = comment(reviewer.page, 'Sorry, wrong thread.');
  await wrong.getByRole('button', { name: 'Delete' }).click();
  await expect(wrong).toContainText('Delete this comment for everyone?');
  await audit(reviewer.page, 'a comment about to be deleted');
  await wrong.getByRole('button', { name: 'Keep it' }).click();
  await expect(wrong.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await wrong.getByRole('button', { name: 'Delete', exact: true }).click();
  await wrong.getByRole('button', { name: 'Delete it' }).click();
  await expect(comment(reviewer.page, 'Sorry, wrong thread.')).toHaveCount(0);
  await expect(comment(owner.page, 'Sorry, wrong thread.')).toHaveCount(0, { timeout: 15_000 });

  // A comment deleted while its author is changing it: the form goes, and they are told.
  await comment(reviewer.page, 'Is that the median, then?')
    .getByRole('button', { name: 'Change' })
    .click();
  await comment(owner.page, 'Is that the median, then?')
    .getByRole('button', { name: 'Delete' })
    .click();
  await comment(owner.page, 'Is that the median, then?')
    .getByRole('button', { name: 'Delete it' })
    .click();
  await expect(theirs).toContainText('The comment you were changing has been deleted.', {
    timeout: 15_000,
  });
  await expect(theirs.getByLabel('Your comment')).toHaveCount(0);

  // The last comment goes: so does the thread, and its mark in the text, on both pages.
  await comment(owner.page, 'The tail.').getByRole('button', { name: 'Delete' }).click();
  await comment(owner.page, 'The tail.').getByRole('button', { name: 'Delete it' }).click();
  await expect(thread(owner.page)).toHaveCount(0);
  await expect(owner.page.locator(`${VISUAL} .thread-mark`)).toHaveCount(0);
  await expect(thread(reviewer.page)).toHaveCount(0, { timeout: 15_000 });
  await expect(reviewer.page.locator(`${VISUAL} .thread-mark`)).toHaveCount(0);
  await expect(theirs.getByText('No open threads on this file.')).toBeVisible();
});
