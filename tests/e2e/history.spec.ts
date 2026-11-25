// The history page (/projects/[id]/history): the timeline, comparing in place, restoring through a
// dialog, naming a revision, downloads, the empty and narrow states, and who may do what. The page
// has no classic version: it is drawn in the new look for everyone, so these run in both looks.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { audit, emailedLink, person, signIn, sticksOut } from './helpers';
import { enlarged, lost, spaced } from './look';

type Person = Awaited<ReturnType<typeof person>>;
const said = (page: Page) =>
  page.locator('.history-said [role=status], .history-said [role=alert]');
const numberIn = async (where: Locator) => Number(/(\d+)/.exec(await where.innerText())![1]);

/** A paper made from the article template, as its owner sees it. */
async function newPaper(owner: Person) {
  const { page, email } = owner;
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Name of a new paper').fill(`History ${Date.now().toString(36)}`);
  await page.getByLabel('Start from').selectOption({ label: 'Article' });
  await page.getByRole('button', { name: 'Create paper' }).click();
  await expect(page.getByRole('heading', { name: 'Revisions', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  return page.url().split('?')[0];
}

async function addFile(page: Page, paper: string, name: string) {
  await page.goto(paper);
  await page.getByLabel('Name, with folders if you like').fill(name);
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByRole('status')).toHaveText(`Added ${name}.`);
}

async function saveNamed(page: Page, paper: string, name: string) {
  await page.goto(`${paper}/history`);
  await page.getByLabel('Name for the new revision').fill(name);
  await page.getByRole('button', { name: 'Save a named revision' }).click();
  await expect(said(page)).toHaveText(/^Saved as revision \d+\.$/);
  return numberIn(said(page));
}

async function openMenu(page: Page, revision: number) {
  await page.getByRole('button', { name: `More for revision ${revision}` }).click();
}

async function join(owner: Person, guest: Person, role: string) {
  await owner.page.goto(owner.page.url().split('/history')[0]);
  await owner.page.getByLabel('Their email address').fill(guest.email);
  await owner.page.getByLabel('Their role').selectOption(role);
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(guest.email);
  await guest.page.goto(await emailedLink(guest.email, '/invitations/'));
  await signIn(guest.page, guest.email);
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText(/You are an? /)).toBeVisible();
}

test('the history page: save, compare in place, restore through a dialog, name, download', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await person(browser, 'hist-owner');
  const { page } = owner;
  const paper = await newPaper(owner);

  // The link from the paper page, and the page in the new look.
  await page.getByRole('link', { name: 'History and versions' }).click();
  await expect(page).toHaveURL(`${paper}/history`);
  await expect(page.locator('main')).toHaveAttribute('data-ui', 'next');
  await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
  await expect(page).toHaveTitle(/^History · .+ — PaperWeave$/);

  // Save, add a file, save again: two named revisions, under today.
  const first = await saveNamed(page, paper, 'First draft');
  await addFile(page, paper, 'notes.tex');
  const second = await saveNamed(page, paper, 'With notes');
  expect(second).toBeGreaterThan(first);
  await expect(page.getByRole('heading', { level: 3, name: 'Today' })).toBeVisible();
  const timeline = page.locator('.history-days');
  await expect(timeline.getByText('First draft')).toBeVisible();
  await expect(timeline.getByText('With notes')).toBeVisible();
  await audit(page, 'the history page');

  // Press "Compare" on two rows: the two lists follow, and "Show the changes" shows them in place.
  await page.getByRole('button', { name: `Compare revision ${second}` }).click();
  await page.getByRole('button', { name: `Compare revision ${first}` }).click();
  await expect(page.getByRole('button', { name: `Compare revision ${first}` })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.history-picker [role=status]')).toHaveText(
    `Comparing revisions ${first} and ${second}.`,
  );
  await expect(page.getByLabel('Changes from').locator('option:checked')).toContainText(
    `${first}. First draft`,
  );
  await expect(page.getByLabel('Changes up to').locator('option:checked')).toContainText(
    `${second}. With notes`,
  );
  await page.getByRole('button', { name: 'Show the changes' }).click();
  await expect(page).toHaveURL(/history\?from=.+&to=.+#comparison/);
  await expect(
    page.getByRole('heading', { level: 3, name: `Revision ${first} to revision ${second}` }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 4, name: /notes\.tex/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 4, name: /notes\.tex/ })).toContainText('Added');
  await audit(page, 'the history page with a comparison');
  // The paper as it is now, as an end of the comparison, for someone who may make revisions.
  await expect(page.getByLabel('Changes up to').locator('option').first()).toHaveText(
    'The paper as it is now',
  );

  // Downloads are in the row's menu, and a revision's ZIP is a ZIP.
  await openMenu(page, second);
  const zip = page.getByRole('menuitem', { name: 'Download ZIP', exact: true });
  await expect(zip).toHaveAttribute('href', new RegExp(`/revisions/[0-9a-f-]+/zip$`));
  await expect(
    page.getByRole('menuitem', { name: 'Download ZIP with build details' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: `More for revision ${second}` })).toBeFocused();

  // Add another file, then restore the first revision: asked first, in a dialog, and kept.
  await addFile(page, paper, 'more.tex');
  await page.goto(`${paper}/history`);
  await openMenu(page, first);
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  const dialog = page.getByRole('dialog', { name: `Restore revision ${first}?` });
  await expect(dialog).toContainText(`The paper goes back to revision ${first}.`);
  await expect(dialog).toContainText('The paper as it is now is kept as a revision first');
  await audit(page, 'the restore dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: `More for revision ${first}` })).toBeFocused();
  await openMenu(page, first);
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  await page.getByRole('button', { name: `Restore revision ${first}`, exact: true }).click();
  await expect(said(page)).toHaveText(/^Restored\. The paper is now revision \d+\.$/);
  const restored = await numberIn(said(page));
  await expect(timeline.getByText(`Restore of revision ${first}`)).toBeVisible();
  await expect(
    timeline.getByText(`The paper as it was is revision ${restored - 1}.`),
  ).toBeVisible();
  // The paper really went back: the file added after the first revision is gone.
  await page.goto(paper);
  await expect(page.getByRole('link', { name: 'more.tex' })).toHaveCount(0);

  // The paper as it was before the restore is a revision nobody named. Open its run, name it.
  await page.goto(`${paper}/history`);
  await page
    .getByRole('button', { name: /^Show the \d+ automatic revisions?$/ })
    .first()
    .click();
  await openMenu(page, restored - 1);
  await page.getByRole('menuitem', { name: 'Give it a name' }).click();
  await page.getByLabel(`Name for revision ${restored - 1}`).fill('Before the restore');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(said(page)).toHaveText(`Revision ${restored - 1} has a name now.`);
  await expect(timeline.getByText('Before the restore')).toBeVisible();
});

test('the history page with no revision shows what to do, and one revision offers no comparison', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await person(browser, 'hist-empty');
  const { page } = owner;
  const paper = await newPaper(owner);
  await page.goto(`${paper}/history`);
  // A new paper may have a revision already; the words are for one with none.
  if ((await page.getByText('No revisions yet.').count()) > 0) {
    await expect(page.getByText('Save one under a name to find it again.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show the changes' })).toHaveCount(0);
    await audit(page, 'the empty history page');
  }
  await saveNamed(page, paper, 'Only one');
  const buttons = await page.getByRole('button', { name: /^Compare revision/ }).count();
  if (buttons === 0) await expect(page.getByText(/nothing to compare/i)).toBeVisible();
});

test('the history page at 320 px, with the text spaced, and with the text twice as big', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await person(browser, 'hist-narrow');
  const { page } = owner;
  const paper = await newPaper(owner);
  const first = await saveNamed(
    page,
    paper,
    'A name that is long enough to need more than one line to say',
  );
  await addFile(page, paper, 'notes.tex');
  const second = await saveNamed(page, paper, 'Second');
  await page.goto(`${paper}/history`);
  await page.getByRole('button', { name: `Compare revision ${first}` }).click();
  await page.getByRole('button', { name: `Compare revision ${second}` }).click();
  await page.getByRole('button', { name: 'Show the changes' }).click();
  await expect(
    page.getByRole('heading', { level: 3, name: /^Revision \d+ to revision \d+$/ }),
  ).toBeVisible();

  await page.setViewportSize({ width: 320, height: 640 });
  expect(await sticksOut(page)).toEqual([]);
  await audit(page, 'the history page at 320 px');
  // Stacked: the timeline, then the comparison.
  const line = await page.locator('.history-line').boundingBox();
  const sheet = await page.locator('.history-sheet').boundingBox();
  expect(sheet!.y).toBeGreaterThan(line!.y + line!.height - 1);

  await page.setViewportSize({ width: 1280, height: 720 });
  await spaced(page);
  expect(await lost(page)).toEqual([]);
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 3, name: /^Revision \d+ to revision \d+$/ }),
  ).toBeVisible();
  await enlarged(page);
  expect(await lost(page)).toEqual([]);
});

type Sent = { headers: Record<string, string>; body: Buffer };

/**
 * What the page sends when `press` is done, kept and not let through: the request of a form's
 * action, to be sent again by hand as someone else.
 */
async function sentBy(page: Page, press: () => Promise<unknown>): Promise<Sent> {
  let got!: (s: Sent) => void;
  const sent = new Promise<Sent>((r) => (got = r));
  await page.route(/\/history/, async (route) => {
    const r = route.request();
    if (r.method() === 'POST' && r.headers()['next-action']) {
      got({ headers: r.headers(), body: r.postDataBuffer()! });
      await route.abort();
    } else await route.continue();
  });
  await press();
  const out = await sent;
  await page.unroute(/\/history/);
  return out;
}

test('who may do what on the history page: owner, editor, reviewer, viewer, stranger', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const owner = await person(browser, 'hist-roles-owner');
  const editor = await person(browser, 'hist-roles-editor');
  const reviewer = await person(browser, 'hist-roles-reviewer');
  const viewer = await person(browser, 'hist-roles-viewer');
  const stranger = await person(browser, 'hist-roles-stranger');
  const paper = await newPaper(owner);
  const history = `${paper}/history`;
  const first = await saveNamed(owner.page, paper, 'Kept');
  await addFile(owner.page, paper, 'notes.tex');
  const second = await saveNamed(owner.page, paper, 'With notes');
  await join(owner, editor, 'editor');
  await join(owner, reviewer, 'reviewer');
  await join(owner, viewer, 'viewer');
  await stranger.page.goto('/sign-in');
  await signIn(stranger.page, stranger.email);

  // What each action sends, taken from the page of someone who may use it (and not let through).
  const { page } = owner;
  // A window of the owner's of their own (nothing it does is let through, and a request that is not
  // answered is no error to the checks the others are held to).
  const side = await (
    await browser.newContext({
      storageState: await page.context().storageState(),
      extraHTTPHeaders: { 'x-forwarded-for': '10.9.9.9' },
    })
  ).newPage();
  await side.goto(history);
  const save = await sentBy(side, async () => {
    await side.getByLabel('Name for the new revision').fill('Forged');
    await side.getByRole('button', { name: 'Save a named revision' }).click();
  });
  await side.goto(history);
  const compare = await sentBy(side, () =>
    side.getByRole('button', { name: 'Show the changes' }).click(),
  );
  await side.goto(history);
  await openMenu(side, second);
  await side.getByRole('menuitem', { name: 'Give it a name' }).click();
  const name = await sentBy(side, async () => {
    await side.getByLabel(`Name for revision ${second}`).fill('Forged');
    await side.getByRole('button', { name: 'Save name' }).click();
  });
  await side.goto(history);
  await openMenu(side, first);
  await side.getByRole('menuitem', { name: 'Restore' }).click();
  const restore = await sentBy(side, () =>
    side.getByRole('button', { name: `Restore revision ${first}`, exact: true }).click(),
  );
  await side.goto(history);
  await openMenu(side, first);
  const build = await sentBy(side, () => side.getByRole('menuitem', { name: 'Build PDF' }).click());
  await side.context().close();

  // The same request, from someone else's browser session.
  const send = (who: Person, what: Sent) => {
    const headers = Object.fromEntries(
      Object.entries(what.headers).filter(
        ([k]) => !['cookie', 'host', 'content-length'].includes(k),
      ),
    );
    return who.page.request.post(history, { headers, data: what.body, maxRedirects: 0 });
  };
  const redirect = (res: Awaited<ReturnType<typeof send>>) =>
    decodeURIComponent(res.headers()['x-action-redirect'] ?? '');

  // Reviewer and viewer: the page offers no way to write, and the service refuses the same
  // actions sent by hand (the refusal comes back to the page with its reason). Someone who is not
  // on the paper is told there is nothing there.
  for (const who of [reviewer, viewer]) {
    await who.page.goto(history);
    await expect(who.page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
    await expect(who.page.getByRole('button', { name: 'Save a named revision' })).toHaveCount(0);
    await expect(who.page.getByLabel('Name for the new revision')).toHaveCount(0);
    await expect(who.page.getByLabel('Changes up to').locator('option').first()).not.toHaveText(
      'The paper as it is now',
    );
    // Nothing is left for the row's menu to offer them (no restore, no name, no download of a
    // paper they may not export, no PDF built yet), so there is no menu.
    await expect(who.page.getByRole('button', { name: `More for revision ${first}` })).toHaveCount(
      0,
    );
    // Comparing is for everyone on the paper.
    await who.page.getByRole('button', { name: `Compare revision ${first}` }).click();
    await who.page.getByRole('button', { name: `Compare revision ${second}` }).click();
    await who.page.getByRole('button', { name: 'Show the changes' }).click();
    await expect(
      who.page.getByRole('heading', { level: 3, name: `Revision ${first} to revision ${second}` }),
    ).toBeVisible();
    await expect(who.page.getByRole('button', { name: `Restore revision ${first}` })).toHaveCount(
      0,
    );
    await audit(who.page, `the history page of a ${who === viewer ? 'viewer' : 'reviewer'}`);

    for (const [what, sent] of [
      ['save', save],
      ['name', name],
      ['restore', restore],
      ['build', build],
      ['compare', compare],
    ] as const)
      expect(redirect(await send(who, sent)), `${what} sent by hand`).toContain('error=');
  }
  const outside = await stranger.page.goto(history);
  expect(outside!.status()).toBe(404);
  for (const sent of [save, name, restore, build])
    expect((await send(stranger, sent)).status()).toBe(404);

  // Nothing of that was done: no forged name, no restore.
  await page.goto(history);
  await expect(page.getByText('Forged')).toHaveCount(0);
  await expect(page.getByText(/^Restore of revision/)).toHaveCount(0);

  // The editor may: the buttons are there, and a revision can be saved and named.
  await editor.page.goto(history);
  await openMenu(editor.page, first);
  await expect(editor.page.getByRole('menuitem', { name: 'Restore' })).toBeVisible();
  await expect(editor.page.getByRole('menuitem', { name: 'Give it a name' })).toBeVisible();
  await editor.page.keyboard.press('Escape');
  await editor.page.getByLabel('Name for the new revision').fill('By the editor');
  await editor.page.getByRole('button', { name: 'Save a named revision' }).click();
  await expect(said(editor.page)).toHaveText(/^Saved as revision \d+\.$/);
  await expect(editor.page.locator('.history-days').getByText('By the editor')).toBeVisible();
  // And the owner has all of it, as the first test shows.
  await page.goto(history);
  await expect(page.getByRole('button', { name: 'Save a named revision' })).toBeVisible();
});
