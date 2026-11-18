// Sign-in, papers, people and invitations, through the real pages and real emails.
// Needs the services in infra/compose.yaml; email is read back from the local mail catcher.
import { type Browser, expect, type Page, test } from '@playwright/test';

const MAIL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const run = Date.now().toString(36);
const address = (who: string) => `${who}-${run}@example.org`;

/** The first link in the newest email sent to an address. */
async function emailedLink(to: string, containing: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const found = await (
      await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
    ).json();
    for (const m of found.messages ?? []) {
      const { Text } = await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json();
      const link = /https?:\/\/\S+/.exec(Text as string)?.[0];
      if (link?.includes(containing)) return link;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email with a ${containing} link reached ${to}`);
}

/** Ask for a sign-in link on the page that is showing the form, then follow it. */
async function signIn(page: Page, email: string) {
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('Check');
  await page.goto(await emailedLink(email, '/magic-link/verify'));
}

async function person(browser: Browser, who: string) {
  const page = await (await browser.newContext()).newPage();
  return { page, email: address(who) };
}

test('sign in, create a paper, invite people, and keep outsiders out', async ({ browser }) => {
  const owner = await person(browser, 'owner');
  const reviewer = await person(browser, 'reviewer');
  const outsider = await person(browser, 'outsider');

  // Nobody is signed in: the app sends you to the sign-in page and back.
  await owner.page.goto('/projects');
  await expect(owner.page).toHaveURL(/\/sign-in\?next=%2Fprojects/);
  await signIn(owner.page, owner.email);
  await expect(owner.page.getByRole('heading', { name: 'Your papers' })).toBeVisible();

  await owner.page.getByLabel('Name of a new paper').fill(`Merge latency ${run}`);
  await owner.page.getByRole('button', { name: 'Create paper' }).click();
  await expect(owner.page.getByRole('heading', { name: `Merge latency ${run}` })).toBeVisible();
  await expect(owner.page.getByText('You are the owner')).toBeVisible();
  const paper = owner.page.url();

  await owner.page.getByLabel('Their email address').fill(reviewer.email);
  await owner.page.getByLabel('Their role').selectOption('reviewer');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(
    `Invitation sent to ${reviewer.email}`,
  );

  // The reviewer follows the invitation before ever signing in.
  const invitation = await emailedLink(reviewer.email, '/invitations/');
  await reviewer.page.goto(invitation);
  await expect(reviewer.page).toHaveURL(/\/sign-in\?next=%2Finvitations%2F/);
  await signIn(reviewer.page, reviewer.email);
  await expect(
    reviewer.page.getByRole('heading', { name: `Join “Merge latency ${run}”` }),
  ).toBeVisible();
  await reviewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(reviewer.page.getByText('You are a reviewer')).toBeVisible();
  // A reviewer sees who is on the paper but cannot manage them.
  await expect(reviewer.page.getByRole('rowheader', { name: owner.email })).toBeVisible();
  await expect(reviewer.page.getByRole('heading', { name: 'Invite someone' })).toHaveCount(0);
  await expect(reviewer.page.getByRole('button', { name: 'Change' })).toHaveCount(0);

  // Someone else cannot see the paper, reuse the invitation, or use one sent to another address.
  await outsider.page.goto('/sign-in');
  await signIn(outsider.page, outsider.email);
  expect((await outsider.page.goto(paper))?.status()).toBe(404);
  await outsider.page.goto(invitation);
  await expect(outsider.page.getByRole('heading', { name: 'not valid any more' })).toBeVisible();

  await owner.page.getByLabel('Their email address').fill(address('someone-else'));
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await outsider.page.goto(await emailedLink(address('someone-else'), '/invitations/'));
  await outsider.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(outsider.page.locator('main [role=alert]')).toContainText(
    'sent to a different email address',
  );
  expect((await outsider.page.goto(paper))?.status()).toBe(404);

  // The owner changes the reviewer's role, then removes them: both take effect on the next request.
  await owner.page.reload();
  await owner.page.getByLabel(`Role of ${reviewer.email}`).selectOption('viewer');
  await owner.page
    .getByRole('row', { name: reviewer.email })
    .getByRole('button', { name: 'Change' })
    .click();
  await expect(owner.page.getByRole('status')).toContainText('Role changed');
  await reviewer.page.reload();
  await expect(reviewer.page.getByText('You are a viewer')).toBeVisible();
  await owner.page.getByRole('button', { name: `Remove ${reviewer.email}` }).click();
  await expect(owner.page.getByRole('rowheader', { name: reviewer.email })).toHaveCount(0);
  expect((await reviewer.page.reload())?.status()).toBe(404);

  // Signing out ends the session.
  await owner.page.getByRole('link', { name: 'All papers' }).click();
  await owner.page.getByRole('button', { name: 'Sign out' }).click();
  await expect(owner.page).toHaveURL(/\/sign-in/);
  await owner.page.goto(paper);
  await expect(owner.page).toHaveURL(/\/sign-in\?next=/);
});

test('sign-in never sends people to another site', async ({ browser }) => {
  const visitor = await person(browser, 'redirect');
  await visitor.page.goto('/sign-in?next=//evil.example/steal');
  await signIn(visitor.page, visitor.email);
  await expect(visitor.page).toHaveURL(/^http:\/\/localhost:3100\/projects$/);
});
