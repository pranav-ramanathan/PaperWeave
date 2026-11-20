// What people are told, and how long they wait, when the mail server does not answer. The
// mail container is paused for these (docker pause), and always unpaused again. Needs the
// services in infra/compose.yaml and Docker.
import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { emailedLink, person, run, selectWord, signIn } from './helpers';

const MAIL_CONTAINER = process.env.MAIL_CONTAINER ?? 'infra-mail-1';
const VISUAL = '.editor .visual .ProseMirror';
const MAIN =
  '\\documentclass{article}\n\\begin{document}\nLatency stays below forty milliseconds for most edits.\n\\end{document}\n';

/** Run `work` with the mail server not answering; it answers again afterwards, whatever happens. */
async function withMailPaused<T>(work: () => Promise<T>): Promise<T> {
  execSync(`docker pause ${MAIL_CONTAINER}`);
  try {
    return await work();
  } finally {
    try {
      execSync(`docker unpause ${MAIL_CONTAINER}`, { stdio: 'pipe' });
    } catch {
      /* it was not paused */
    }
  }
}

test('with the mail server not answering, a comment mentioning two people is saved at once, and once', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await person(browser, 'down-owner');
  const editor = await person(browser, 'down-editor');
  const reviewer = await person(browser, 'down-reviewer');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Mail down ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  for (const [who, role] of [
    [editor, 'editor'],
    [reviewer, 'reviewer'],
  ] as const) {
    await owner.page.getByLabel('Their email address').fill(who.email);
    await owner.page.getByLabel('Their role').selectOption(role);
    await owner.page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(owner.page.getByRole('status')).toContainText(who.email);
    await who.page.goto(await emailedLink(who.email, '/invitations/'));
    await signIn(who.page, who.email);
    await who.page.getByRole('button', { name: 'Join this paper' }).click();
    await expect(
      who.page.getByText(`You are ${role === 'editor' ? 'an' : 'a'} ${role}`),
    ).toBeVisible();
  }

  await reviewer.page.getByRole('link', { name: 'main.tex' }).first().click();
  const panel = reviewer.page.getByRole('region', { name: 'Comments' });
  await selectWord(reviewer.page, VISUAL, 'forty');
  await panel.getByRole('button', { name: 'Comment on the selected text' }).click();
  await panel.getByLabel('Comment', { exact: true }).fill('Is that the median or the tail?');
  await panel.getByRole('checkbox', { name: owner.email }).check();
  await panel.getByRole('checkbox', { name: editor.email }).check();

  await withMailPaused(async () => {
    const started = Date.now();
    await panel.getByRole('button', { name: 'Start thread' }).click();
    // Two emails that cannot be sent, one after the other, held this up for a minute. The
    // margin is wide: it answers in well under a second.
    await expect(reviewer.page.getByRole('article', { name: 'Thread on “forty”' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(panel.getByRole('button', { name: 'Start thread' })).toHaveCount(0, {
      timeout: 5_000,
    });
    expect(Date.now() - started, 'the time to answer').toBeLessThan(5_000);
    // And it is there once, also when the page is read afresh.
    await reviewer.page.reload();
    await expect(reviewer.page.getByRole('article', { name: 'Thread on “forty”' })).toHaveCount(1);
  });
});

test('with the mail server not answering, a sign-in link fails soon and says why', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const visitor = await person(browser, 'down-signin');
  await visitor.page.goto('/sign-in');
  await visitor.page.getByLabel('Email address').fill(visitor.email);
  await withMailPaused(async () => {
    const started = Date.now();
    await visitor.page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(visitor.page.locator('main [role=alert]')).toHaveText(
      'The link could not be sent: the email service did not answer. Try again in a few minutes.',
      { timeout: 20_000 },
    );
    expect(Date.now() - started, 'the time to fail').toBeLessThan(20_000);
  });
  // Not blamed on the address, and not counted against it: once the server answers, it works.
  await visitor.page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(visitor.page.getByRole('status')).toContainText('Check');
});
