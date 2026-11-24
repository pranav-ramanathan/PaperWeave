// Sign-in, papers, people and invitations, through the real pages and real emails.
// Needs the services in infra/compose.yaml; email is read back from the local mail catcher.
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import {
  address,
  audit,
  confirmSignIn,
  emailedLink,
  MAIL,
  person,
  run,
  scriptsHeld,
  signIn,
} from './helpers';

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

test("a button pressed twice before the page's script has started does its work once", async ({
  browser,
}) => {
  const owner = await person(browser, 'twice-early');
  const { page } = owner;
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
  const release = await scriptsHeld(page);
  await page.goto('/projects', { waitUntil: 'domcontentloaded' });
  const name = `Twice early ${run}`;
  await page.getByLabel('Name of a new paper').fill(name);
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/projects') posts++;
  });
  // The answer comes 300 ms late, so that the first post is still on its way at the second press
  // however fast the server is.
  await page.route(
    (u) => u.pathname === '/projects',
    async (route) => {
      if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 300));
      await route.continue();
    },
  );
  // Two presses 50 ms apart: in one task the browser itself drops the first post.
  await page
    .getByRole('button', { name: 'Create paper' })
    .evaluate(
      (b: HTMLButtonElement) =>
        new Promise<void>((r) => {
          b.click();
          setTimeout(() => {
            b.click();
            r();
          }, 50);
        }),
    )
    .catch(() => {}); // the page may have left before the second press
  // Not 'load': the new page's scripts are held too.
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/, { waitUntil: 'domcontentloaded' });
  release();
  expect(posts).toBe(1);
  await page.goto('/projects');
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(1);
});

test("the sign-in form works for someone quicker than the page's script", async ({ browser }) => {
  const visitor = await person(browser, 'quick');
  const { page } = visitor;
  const release = await scriptsHeld(page);
  await page.goto('/sign-in?next=%2Fprojects', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email address').fill(visitor.email);
  // Nothing can send it yet, and Enter in the field must not post it as a plain GET.
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeDisabled();
  await page.getByLabel('Email address').press('Enter');
  expect(page.url()).not.toContain('email=');
  // Scripts let through: what was typed is what is sent.
  release();
  const button = page.getByRole('button', { name: 'Email me a sign-in link' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('status')).toContainText('Check');
  await expect(page.getByRole('status')).toContainText(visitor.email);
});

test('sign-in never sends people to another site', async ({ browser }) => {
  const visitor = await person(browser, 'redirect');
  await visitor.page.goto('/sign-in?next=//evil.example/steal');
  await signIn(visitor.page, visitor.email);
  await expect(visitor.page).toHaveURL(/^http:\/\/localhost:3100\/projects$/);
});

test('a tab between the slashes does not lead off the site, signed in or from the emailed page', async ({
  browser,
}) => {
  const visitor = await person(browser, 'tab-redirect');
  await visitor.page.goto('/sign-in');
  await signIn(visitor.page, visitor.email);
  // Signed in: the sign-in page sends people on, and only to a path here.
  for (const next of ['/%09/evil.example/x', '/%0a/evil.example/x', '/%0d/evil.example/x']) {
    const answer = await visitor.page.request.get(`/sign-in?next=${next}`, { maxRedirects: 0 });
    expect(answer.status(), next).toBe(307);
    expect(answer.headers()['location'], next).toBe('/projects');
  }
  // The emailed page, with the destination swapped by someone who made the link up.
  const other = await person(browser, 'tab-confirm');
  await other.page.goto('/sign-in');
  await other.page.getByLabel('Email address').fill(other.email);
  await other.page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(other.page.getByRole('status')).toContainText('Check');
  const link = new URL(await emailedLink(other.email, '/sign-in/confirm'));
  link.searchParams.set('next', '/\t/evil.example/x');
  await confirmSignIn(other.page, link.href);
  await expect(other.page).toHaveURL(/^http:\/\/localhost:3100\/projects$/);
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
  // A picture is shown as a picture and as nothing else; the chart's page is still a page.
  for (const path of ['/projects/x/picture?target=a', '/projects/x/charts/y/png']) {
    const headers = (await request.get(path, { maxRedirects: 0 })).headers();
    expect(headers['content-security-policy'], path).toBe("default-src 'none'; sandbox");
    expect(headers['x-content-type-options'], path).toBe('nosniff');
    expect(headers['x-frame-options'], path).toBe('DENY');
  }
  const chartPage = await request.get('/projects/x/charts/y', { maxRedirects: 0 });
  expect(chartPage.headers()['content-security-policy']).toContain("script-src 'self' 'nonce-");
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
  const link = await emailedLink(visitor.email, '/sign-in/confirm');
  await confirmSignIn(again.page, link);
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

test('a mail scanner opening the sign-in link does not use it up; the person can still sign in', async ({
  browser,
  request,
  baseURL,
}) => {
  const visitor = await person(browser, 'scanned');
  await visitor.page.goto('/sign-in?next=%2Fprojects%3Fthread%3D1');
  await visitor.page.getByLabel('Email address').fill(visitor.email);
  await visitor.page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(visitor.page.getByRole('status')).toContainText('Check');
  const link = await emailedLink(visitor.email, '/sign-in/confirm');
  // The scanner: no cookies, plain fetches, nothing pressed.
  const scan = await request.get(link, { maxRedirects: 0 });
  expect(scan.status()).toBe(200);
  expect(scan.headers()['set-cookie']).toBeUndefined();
  expect(scan.headers()['cache-control']).toContain('no-store');
  expect(scan.headers()['referrer-policy']).toBe('same-origin');
  // Not the library's own link either: it signs in on a GET, and is switched off.
  const token = new URL(link).searchParams.get('token')!;
  const old = await request.get(
    `${baseURL}/api/auth/magic-link/verify?token=${token}&callbackURL=%2Fprojects`,
    { maxRedirects: 0 },
  );
  expect(old.status()).toBe(404);
  expect(old.headers()['set-cookie']).toBeUndefined();
  // The person's own visit.
  await visitor.page.goto(link);
  await expect(visitor.page.getByRole('heading', { name: 'Sign in to PaperWeave' })).toBeVisible();
  await expect(visitor.page.getByRole('button', { name: 'Sign in', exact: true })).toBeFocused();
  await audit(visitor.page, 'the sign-in confirm page');
  await visitor.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Where they were going survives.
  await expect(visitor.page).toHaveURL(/\/projects\?thread=1$/);
  await expect(visitor.page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
  // A second press of the same link, elsewhere, says it is used.
  const other = await person(browser, 'scanned-again');
  await confirmSignIn(other.page, link);
  await expect(other.page.locator('main [role=alert]')).toHaveText(
    'That sign-in link has been used or has expired. Ask for a new one below.',
  );
});

test('one address is sent a burst of sign-in links, then is spaced, whoever asks for them', async ({
  browser,
}) => {
  // Three people, each asking a few times for a link to be sent to someone else. None of them
  // asks often enough to be stopped for that; together they pass what one address is sent in a
  // burst (three), and the rest are told a link was sent a few minutes ago.
  const inbox = address(`inbox-${test.info().repeatEachIndex}`);
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
        await expect(said).toContainText(
          'A sign-in link was sent to this address a few minutes ago',
        );
      }
    }
  }
  expect({ sent, refused }).toEqual({ sent: 3, refused: 9 });
  const mail = await (
    await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${inbox}`)}`)
  ).json();
  expect(mail.messages).toHaveLength(3);
});

test('the confirm page says whose sign-in it is, and showing it does not use the link up', async ({
  browser,
}) => {
  const visitor = await person(browser, 'whose');
  await visitor.page.goto('/sign-in');
  await visitor.page.getByLabel('Email address').fill(visitor.email);
  await visitor.page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(visitor.page.getByRole('status')).toContainText('Check');
  const link = await emailedLink(visitor.email, '/sign-in/confirm');
  const masked = `${visitor.email[0]}…${visitor.email.slice(visitor.email.indexOf('@'))}`;
  // Seen twice: the page reads the link and changes nothing.
  for (let i = 0; i < 2; i++) {
    await visitor.page.goto(link);
    await expect(visitor.page.getByText(`This signs you in as ${masked}`)).toBeVisible();
    // The button says what it is for, to someone using a screen reader.
    await expect(
      visitor.page.getByRole('button', { name: 'Sign in', exact: true }),
    ).toHaveAccessibleDescription(new RegExp(`signs you in as ${masked}`));
    // The whole address is not on the page, which anyone holding the link can open.
    await expect(visitor.page.locator('body')).not.toContainText(visitor.email);
  }
  await visitor.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(visitor.page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
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

test('inviting someone already on the paper is refused and points to their role', async ({
  browser,
}) => {
  const owner = await person(browser, 'member-owner');
  const guest = await person(browser, 'member-guest');
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Name of a new paper').fill(`Already ${run}`);
  await owner.page.getByRole('button', { name: 'Create paper' }).click();
  await expect(owner.page.getByRole('heading', { name: `Already ${run}` })).toBeVisible();

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
  await expect(
    owner.page.getByRole('alert').filter({ hasText: 'already on this paper' }),
  ).toHaveText(
    `${guest.email} is already on this paper as a viewer. To change that, choose a role beside their address under People and press Change.`,
  );
  await expect(owner.page.getByRole('heading', { name: 'Invited, not yet joined' })).toHaveCount(0);
  // No second email: the one invitation sent is the only one with a link.
  const found = await (
    await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${guest.email}`)}`)
  ).json();
  let withLink = 0;
  for (const m of found.messages ?? []) {
    const { Text } = await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json();
    if (/\/invitations\//.test(Text as string)) withLink++;
  }
  expect(withLink).toBe(1);
  await audit(owner.page, 'a refused invitation to someone already on the paper');

  // The pointer works: the role control under People.
  await owner.page.getByLabel(`Role of ${guest.email}`).selectOption('editor');
  await owner.page
    .getByRole('row', { name: guest.email })
    .getByRole('button', { name: 'Change' })
    .click();
  await expect(owner.page.getByRole('status')).toContainText('Role changed');
  await guest.page.reload();
  await expect(guest.page.getByText('You are an editor')).toBeVisible();
});

test('the owner renames a paper; a viewer cannot', async ({ browser }) => {
  const owner = await person(browser, 'rename-owner');
  const guest = await person(browser, 'rename-guest');
  const { page } = owner;
  const oldName = `paper-final-v3 (1) ${run}`;
  const newName = `Merge latency: \u201Cfinal\u201D ${run}`;
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Name of a new paper').fill(oldName);
  await page.getByRole('button', { name: 'Create paper' }).click();
  await expect(page.getByRole('heading', { name: oldName })).toBeVisible();
  const paper = page.url();

  await page.getByLabel('Their email address').fill(guest.email);
  await page.getByLabel('Their role').selectOption('viewer');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText('Invitation sent');
  await guest.page.goto('/sign-in');
  await signIn(guest.page, guest.email);
  await guest.page.goto(await emailedLink(guest.email, '/invitations/'));
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText('You are a viewer')).toBeVisible();

  await page.getByText('Rename this paper').click();
  await audit(page, 'the paper with its rename form open');
  await page.getByLabel('New name for this paper').fill(newName);
  await page.getByRole('button', { name: 'Rename paper' }).click();
  await expect(page.getByRole('status')).toContainText(
    `This paper is now called \u201C${newName}\u201D.`,
  );
  await expect(page.getByRole('heading', { name: newName })).toBeVisible();
  await expect(page).toHaveTitle(`${newName} \u2014 PaperWeave`);
  await audit(page, 'a renamed paper');

  await page.goto('/projects');
  await expect(page.getByRole('link', { name: newName })).toBeVisible();
  await expect(page.getByRole('link', { name: oldName })).toHaveCount(0);

  await page.goto(paper);
  await page.getByText('Rename this paper').click();
  await page.getByLabel('New name for this paper').fill('   ');
  await page.getByRole('button', { name: 'Rename paper' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'needs a name' })).toHaveText(
    'A project needs a name of at most 200 characters.',
  );
  await expect(page.getByRole('heading', { name: newName })).toBeVisible();

  await guest.page.reload();
  await expect(guest.page.getByRole('heading', { name: newName })).toBeVisible();
  await expect(guest.page.getByText('Rename this paper')).toHaveCount(0);
});

test('a sign-in form whose request is never answered gives up, says so and can be used again', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const visitor = await person(browser, 'quiet-signin');
  await visitor.page.goto('/sign-in');
  await visitor.page.getByLabel('Email address').fill(visitor.email);
  // The server takes the request and says nothing.
  await visitor.page.route('**/api/auth/sign-in/magic-link', () => {});
  const send = visitor.page.getByRole('button', { name: 'Email me a sign-in link' });
  await send.click();
  await expect(visitor.page.locator('main [role=alert]')).toContainText('did not answer', {
    timeout: 60_000,
  });
  await expect(send).toBeEnabled();
});

test('an invitation opened before signing in says so and for which address; one no longer valid says that', async ({
  browser,
}) => {
  const owner = await person(browser, 'asks-owner');
  const guest = await person(browser, 'asks-guest');
  const late = await person(browser, 'asks-late');
  const name = `Asked in ${run}`;
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Name of a new paper').fill(name);
  await owner.page.getByRole('button', { name: 'Create paper' }).click();
  await expect(owner.page.getByRole('heading', { name })).toBeVisible();
  await owner.page.getByLabel('Their email address').fill(guest.email);
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(`Invitation sent to ${guest.email}`);
  const invitation = await emailedLink(guest.email, '/invitations/');

  // Not signed in: the page that asks for an address says why it is asking, and for which one.
  await guest.page.goto(invitation);
  await expect(guest.page).toHaveURL(/\/sign-in\?next=%2Finvitations%2F/);
  const main = guest.page.locator('main');
  await expect(main).toContainText(
    'You have been invited to a paper on PaperWeave. The invitation is for a…@example.org: sign in with that address',
  );
  // To someone who has not signed in: not the whole address, nor anything of the paper.
  await expect(main).not.toContainText(guest.email);
  await expect(main).not.toContainText(name);
  await expect(guest.page.getByLabel('Email address')).toHaveValue('');
  await audit(guest.page, 'the sign-in page reached from an invitation');
  // It is still there while the link is on its way, and the link leads back to the invitation.
  await signIn(guest.page, guest.email);
  await expect(guest.page.getByRole('heading', { name: `Join “${name}”` })).toBeVisible();
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText('You are an editor')).toBeVisible();

  // The same link again, used by now, opened by someone not signed in: said before they sign in.
  await late.page.goto(invitation);
  await expect(late.page.locator('main')).toContainText(
    'This invitation is not valid any more. It may have been used already or have expired.',
  );
  await expect(late.page.locator('main')).not.toContainText('You have been invited');
  await audit(late.page, 'the sign-in page reached from an invitation that is no longer valid');
  await signIn(late.page, late.email);
  await expect(late.page.getByRole('heading', { name: 'Your papers' })).toBeVisible();

  // An address that only looks like an invitation's, and the plain page, say nothing of one.
  const plain = await person(browser, 'asks-plain');
  await plain.page.goto('/sign-in?next=/invitations/not-a-token');
  await expect(plain.page.getByRole('heading', { name: 'Sign in to PaperWeave' })).toBeVisible();
  await expect(plain.page.locator('main')).not.toContainText('nvit');
});

test('the owner deletes a paper after being shown what goes; an editor with a file open is told, and nobody can open it again', async ({
  browser,
}) => {
  const owner = await person(browser, 'deletes-owner');
  const guest = await person(browser, 'deletes-guest');
  const { page } = owner;
  const name = `Wrong archive ${run}`;
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `${name}.zip`);
  const main =
    '\\documentclass{article}\n\\begin{document}\nNot for this place.\n\\end{document}\n';
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const paper = new URL(page.url()).pathname;

  await page.getByLabel('Their email address').fill(guest.email);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText('Invitation sent');
  await guest.page.goto('/sign-in');
  await signIn(guest.page, guest.email);
  await guest.page.goto(await emailedLink(guest.email, '/invitations/'));
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText('You are an editor')).toBeVisible();

  // An editor is not offered it, and the page that asks is the owner's alone.
  await expect(guest.page.getByRole('link', { name: 'Delete this paper…' })).toHaveCount(0);
  await guest.page.goto(`${paper}/delete`);
  await expect(guest.page.getByRole('main').getByRole('alert')).toHaveText(
    'Only the owner of a paper can delete it.',
  );
  await expect(guest.page.getByRole('button')).toHaveCount(0);
  // The editor has the file open when the paper goes.
  await guest.page.goto(paper);
  await guest.page.getByRole('link', { name: 'main.tex', exact: true }).first().click();
  const status = guest.page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
  await expect(status).toHaveText('All edits saved.');

  // The owner is shown what goes, and nothing has gone yet.
  await page.getByRole('link', { name: 'Delete this paper…' }).click();
  await expect(page.getByRole('heading', { name: `Delete \u201C${name}\u201D` })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('one file');
  await expect(page.getByRole('main')).toContainText(
    'one other person is on the paper, and will lose it too',
  );
  await expect(page.getByRole('main')).toContainText('Nothing has been deleted yet.');
  await audit(page, 'the page that asks before a paper is deleted');
  await page.getByRole('link', { name: 'Back to the paper' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();

  await page.getByRole('link', { name: 'Delete this paper…' }).click();
  await expect(page.getByRole('main')).toContainText('It cannot be undone');
  // Without the paper's exact name nothing is deleted, and the page says why.
  await page.getByLabel(/To confirm, type the paper/).fill(`${name} `.toLowerCase());
  await page.getByRole('button', { name: 'Delete this paper for everyone' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Nothing was deleted');
  await page.goto(paper);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('link', { name: 'Delete this paper…' }).click();
  await page.getByLabel(/To confirm, type the paper/).fill(name);
  await page.getByRole('button', { name: 'Delete this paper for everyone' }).click();
  await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    `Deleted \u201C${name}\u201D. It is gone for everyone who was on it.`,
  );
  await expect(page.getByRole('link', { name })).toHaveCount(0);
  await audit(page, 'the list of papers after one is deleted');

  // The editor's page says so, without a reload, and takes no more typing.
  await expect(status).toHaveText(
    'You no longer have access to this file, or it has been deleted.',
    { timeout: 20_000 },
  );
  await expect(guest.page.locator('.editor-notice')).toHaveText(
    /^You are no longer a member of this paper, or its owner has deleted it\./,
  );

  // Nobody can open it again: the paper, its file, its download, or the page that asks.
  for (const who of [page, guest.page]) {
    await who.goto(paper);
    await expect(who.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
  }
  await page.goto(`${paper}/delete`);
  await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
  expect((await page.request.get(`${paper}/export`)).status()).toBe(404);
  await guest.page.goto('/projects');
  await expect(guest.page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
  await expect(guest.page.getByRole('link', { name })).toHaveCount(0);
});

test('the owner hands the paper to an editor', async ({ browser }) => {
  const owner = await person(browser, 'handover-owner');
  const guest = await person(browser, 'handover-guest');
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Name of a new paper').fill(`Handover ${run}`);
  await owner.page.getByRole('button', { name: 'Create paper' }).click();
  await expect(owner.page.getByRole('heading', { name: `Handover ${run}` })).toBeVisible();
  const paper = new URL(owner.page.url()).pathname;
  await owner.page.getByLabel('Their email address').fill(guest.email);
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText('Invitation sent');
  await guest.page.goto('/sign-in');
  await signIn(guest.page, guest.email);
  await guest.page.goto(await emailedLink(guest.email, '/invitations/'));
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText('You are an editor')).toBeVisible();

  // Only the owner is offered the page, and it has no button for anyone else.
  await guest.page.goto(`${paper}/owner`);
  await expect(guest.page.getByRole('main').getByRole('alert')).toHaveText(
    'Only the owner of a paper can hand it to someone else.',
  );
  await expect(guest.page.getByRole('button')).toHaveCount(0);

  await owner.page.getByRole('link', { name: 'Hand this paper to someone else…' }).click();
  await expect(owner.page.getByRole('main')).toContainText('You cannot take it back');
  await audit(owner.page, 'the page that asks before a paper is handed over');
  await owner.page.getByLabel('The new owner').selectOption({ label: `${guest.email}, editor` });
  await owner.page.getByRole('button', { name: 'Hand over this paper' }).click();
  await expect(owner.page.getByRole('status')).toContainText(
    `${guest.email} is now the owner of this paper`,
  );
  await expect(owner.page.getByText('You are an editor', { exact: true })).toBeVisible();
  await expect(owner.page.getByLabel('Their email address')).toHaveCount(0);
  await expect(owner.page.getByRole('link', { name: 'Delete this paper…' })).toHaveCount(0);

  await guest.page.goto(paper);
  await expect(guest.page.getByText('You are the owner')).toBeVisible();
  await expect(guest.page.getByLabel('Their email address')).toBeVisible();
  await expect(guest.page.getByRole('link', { name: 'Delete this paper…' })).toBeVisible();
});
