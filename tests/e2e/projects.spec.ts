// Sign-in, papers, people and invitations, through the real pages and real emails.
// Needs the services in infra/compose.yaml; email is read back from the local mail catcher.
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { address, audit, emailedLink, MAIL, person, run, signIn } from './helpers';

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
  await audit(reviewer.page, 'an invitation');
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
  // In the app's own words, and no different from an address that leads nowhere.
  await expect(outsider.page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
  await outsider.page.goto(invitation);
  await expect(outsider.page.getByRole('heading', { name: 'not valid any more' })).toBeVisible();
  await audit(outsider.page, 'an invitation that is no longer valid');

  await owner.page.getByLabel('Their email address').fill(address('someone-else'));
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await outsider.page.goto(await emailedLink(address('someone-else'), '/invitations/'));
  // The page says whom it is for, offers no Join, and the account has not become a member.
  await expect(outsider.page.locator('main')).toContainText(
    `This invitation is for ${address('someone-else')}; you are signed in as ${outsider.email}.`,
  );
  await expect(outsider.page.getByRole('button', { name: 'Join this paper' })).toHaveCount(0);
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

test('a button pressed twice does its work once', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await person(browser, 'twice-owner');
  const guest = await person(browser, 'twice-guest');
  const { page } = owner;
  const twice = (b: HTMLButtonElement) => {
    b.click();
    b.click();
  };
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();

  // Create paper, pressed twice in one task: one paper.
  const name = `Twice ${run}`;
  await page.getByLabel('Name of a new paper').fill(name);
  await page.getByRole('button', { name: 'Create paper' }).evaluate(twice);
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.goto('/projects');
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(1);

  // The browser's own required check stops an empty name; the button works after it is filled.
  await page.getByRole('button', { name: 'Create paper' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.getByLabel('Name of a new paper').fill(`Twice again ${run}`);
  await page.getByRole('button', { name: 'Create paper' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.goto('/projects');

  // Import ZIP, pressed twice 300 ms apart: one paper.
  const files = [
    {
      path: 'main.tex',
      bytes: Buffer.from('\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n'),
    },
  ];
  for (let i = 0; i < 300; i++)
    files.push({ path: `parts/part-${i}.tex`, bytes: Buffer.from(`Part ${i}.\n`) });
  const zipName = `Zipped ${run}`;
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `${zipName}.zip`);
  writeFileSync(zip, await writeZip(files));
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page
    .getByRole('button', { name: 'Import ZIP' })
    .evaluate(
      (b: HTMLButtonElement) =>
        new Promise<void>((r) => {
          b.click();
          setTimeout(() => {
            b.click();
            r();
          }, 300);
        }),
    )
    .catch(() => {}); // the page may have left before the second press
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  await page.goto('/projects');
  await expect(page.getByRole('link', { name: zipName, exact: true })).toHaveCount(1);

  // Remove, pressed twice: it works, and says nothing of an error.
  await page.getByRole('link', { name, exact: true }).click();
  await page.getByLabel('Their email address').fill(guest.email);
  await page.getByLabel('Their role').selectOption('reviewer');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText(`Invitation sent to ${guest.email}`);
  await guest.page.goto(await emailedLink(guest.email, '/invitations/'));
  await signIn(guest.page, guest.email);
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText('You are a reviewer')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: `Remove ${guest.email}` }).evaluate(twice);
  await page.waitForLoadState('load');
  await expect(page.getByRole('rowheader', { name: guest.email })).toHaveCount(0);
  expect(page.url()).not.toContain('error=');
  await expect(page.locator('[role=alert]').filter({ hasText: 'not in the project' })).toHaveCount(
    0,
  );

  await page.goto('/projects');
  await audit(page, 'the list of papers');
});

test('sign-in never sends people to another site', async ({ browser }) => {
  const visitor = await person(browser, 'redirect');
  await visitor.page.goto('/sign-in?next=//evil.example/steal');
  await signIn(visitor.page, visitor.email);
  await expect(visitor.page).toHaveURL(/^http:\/\/localhost:3100\/projects$/);
});

test('every answer says how it may be used: not in a frame, not guessed at, not posted elsewhere', async ({
  request,
}) => {
  const policies = new Map<string, string>();
  for (const path of ['/sign-in', '/projects', '/api/sync-ticket']) {
    const headers = (await request.get(path, { maxRedirects: 0 })).headers();
    expect(headers['x-frame-options'], path).toBe('DENY');
    expect(headers['x-content-type-options'], path).toBe('nosniff');
    expect(headers['referrer-policy'], path).toBe('same-origin');
    expect(headers['content-security-policy'], path).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy'], path).toContain("form-action 'self'");
    policies.set(path, headers['content-security-policy']);
  }
  // A page also says which scripts may run on it: those marked with a number made up for that
  // one answer, and what they load. Nothing else, and nothing from anywhere else.
  const page = policies.get('/sign-in')!;
  const number = /script-src 'self' 'nonce-([^']+)' 'strict-dynamic';/.exec(page)?.[1];
  expect(number, page).toBeTruthy();
  expect(page).toContain("default-src 'self'");
  expect(page).toContain("object-src 'none'");
  expect(page).not.toContain('unsafe-eval');
  // Style sheets are held to the same number.
  expect(page).toContain(`style-src-elem 'self' 'nonce-${number}'`);
  // A new number each time, and the page's own scripts carry it: they are the ones that run.
  const answer = await request.get('/sign-in');
  const sent = /'nonce-([^']+)'/.exec(answer.headers()['content-security-policy'])![1];
  expect(sent).not.toBe(number);
  const scripts = (await answer.text()).match(/<script[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) expect(script).toContain(`nonce="${sent}"`);
});

test('a form posted to the site is answered with a path, not with an address', async ({
  request,
}) => {
  // Where a posted form sends the browser next must not be an address the server made up from
  // its own: behind a proxy that is the machine's inner address, which no browser can reach,
  // and which the pages' own policy forbids a form to lead to. A path is right wherever the
  // service is reached from.
  const form = { headers: { origin: 'http://localhost:3100' }, maxRedirects: 0 };
  const paper = '/projects/00000000-0000-4000-8000-000000000000';
  for (const [to, sent, next] of [
    ['/api/projects/import', { zip: 'x' }, '/sign-in?next=%2Fprojects'],
    [`${paper}/files`, { path: 'a.tex' }, `/sign-in?next=${encodeURIComponent(paper)}`],
  ] as const) {
    const answer = await request.post(to, { ...form, multipart: sent });
    expect(answer.status(), to).toBe(303);
    expect(answer.headers().location, to).toBe(next);
  }
});

test('a sign-in link that has been used says so, and never shows its code', async ({ browser }) => {
  const visitor = await person(browser, 'used-link');
  const again = await person(browser, 'used-link-again');
  await visitor.page.goto('/sign-in');
  await signIn(visitor.page, visitor.email);
  await expect(visitor.page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
  // The same link, in a browser that is not signed in.
  const link = await emailedLink(visitor.email, '/magic-link/verify');
  await again.page.goto(link);
  await expect(again.page).toHaveURL(/\/sign-in/);
  await expect(again.page.locator('main [role=alert]')).toHaveText(
    'That sign-in link has been used or has expired. Ask for a new one below.',
  );
  expect(again.page.url()).not.toContain('INVALID_TOKEN');
  await expect(again.page.locator('body')).not.toContainText('INVALID_TOKEN');
  // Asking for a new one from there works, and goes where the first was going.
  await signIn(again.page, visitor.email);
  await expect(again.page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
});

test('one address is sent only so many sign-in links in an hour, whoever asks for them', async ({
  browser,
}) => {
  // Three people, each asking a few times for a link to be sent to someone else. None of them
  // asks often enough to be stopped for that; together they pass what one address is sent.
  const inbox = address('inbox');
  let sent = 0;
  let refused = 0;
  for (const who of ['asks-a', 'asks-b', 'asks-c']) {
    const { page } = await person(browser, who);
    for (let i = 0; i < 4; i++) {
      await page.goto('/sign-in');
      await page.getByLabel('Email address').fill(inbox);
      await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
      const said = page.getByRole('status').or(page.locator('main [role=alert]'));
      await expect(said).toBeVisible();
      if ((await said.getAttribute('role')) === 'status') sent++;
      else {
        refused++;
        await expect(said).toContainText('Only so many links are sent to one address');
      }
    }
  }
  expect({ sent, refused }).toEqual({ sent: 10, refused: 2 });
  const mail = await (
    await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${inbox}`)}`)
  ).json();
  expect(mail.messages).toHaveLength(10);
});

test('the owner sees pending invitations and cancels one', async ({ browser }) => {
  const owner = await person(browser, 'cancel-owner');
  const guest = await person(browser, 'cancel-guest');
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Name of a new paper').fill(`Pending ${run}`);
  await owner.page.getByRole('button', { name: 'Create paper' }).click();
  await expect(owner.page.getByRole('heading', { name: `Pending ${run}` })).toBeVisible();
  await expect(owner.page.getByRole('heading', { name: 'Invited, not yet joined' })).toHaveCount(0);

  await owner.page.getByLabel('Their email address').fill(guest.email);
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(`Invitation sent to ${guest.email}`);
  await expect(owner.page.getByRole('heading', { name: 'Invited, not yet joined' })).toBeVisible();
  await expect(owner.page.getByText(`${guest.email}, as an editor, until`)).toBeVisible();
  await audit(owner.page, 'the paper with a pending invitation');

  const link = await emailedLink(guest.email, '/invitations/');
  await owner.page.getByRole('button', { name: `Cancel the invitation to ${guest.email}` }).click();
  await expect(owner.page.getByRole('status')).toContainText(
    `Invitation to ${guest.email} cancelled`,
  );
  await expect(owner.page.getByRole('heading', { name: 'Invited, not yet joined' })).toHaveCount(0);

  await guest.page.goto('/sign-in');
  await signIn(guest.page, guest.email);
  await guest.page.goto(link);
  await expect(guest.page.getByRole('heading', { name: 'not valid any more' })).toBeVisible();
});

test('an invitation tells someone already on the paper that it changes nothing', async ({
  browser,
}) => {
  const owner = await person(browser, 'member-owner');
  const guest = await person(browser, 'member-guest');
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Name of a new paper').fill(`Already ${run}`);
  await owner.page.getByRole('button', { name: 'Create paper' }).click();
  await expect(owner.page.getByRole('heading', { name: `Already ${run}` })).toBeVisible();
  const paper = owner.page.url();

  await owner.page.getByLabel('Their email address').fill(guest.email);
  await owner.page.getByLabel('Their role').selectOption('viewer');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText('Invitation sent');
  await guest.page.goto('/sign-in');
  await signIn(guest.page, guest.email);
  const firstLink = await emailedLink(guest.email, '/invitations/');
  await guest.page.goto(firstLink);
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText('You are a viewer')).toBeVisible();

  await owner.page.getByLabel('Their email address').fill(guest.email);
  await owner.page.getByLabel('Their role').selectOption('editor');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText('Invitation sent');
  // The mail catcher lists both emails: the link to open is the one that is not the first.
  let secondLink = firstLink;
  await expect(async () => {
    const found = await (
      await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${guest.email}`)}`)
    ).json();
    for (const m of found.messages ?? []) {
      const { Text } = await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json();
      const link = /https?:\/\/\S+\/invitations\/\S+/.exec(Text as string)?.[0];
      if (link && link !== firstLink) secondLink = link;
    }
    expect(secondLink).not.toBe(firstLink);
  }).toPass();
  await guest.page.goto(secondLink);
  await expect(guest.page.locator('main')).toContainText(
    'You are already on this paper as a viewer. This invitation does not change that: ask the owner to change your role.',
  );
  await expect(guest.page.getByRole('button', { name: 'Join this paper' })).toHaveCount(0);
  await audit(guest.page, 'an invitation to someone already on the paper');
  await guest.page.getByRole('link', { name: 'Open the paper' }).click();
  await expect(guest.page).toHaveURL(paper);
});
