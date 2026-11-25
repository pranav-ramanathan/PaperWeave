// The history page with versions (PLAN.md section 14, T43): a merge is a row of its own in the
// timeline, and a revision of this paper can be compared in place with a revision of another paper
// of the family, files paired by their origin. Who may see and do what: owner, editor, reviewer,
// viewer, a stranger, and a member of one paper who is not on the other. Everything is behind the
// `VERSIONS` setting: with it off the page shows no trace.
import { expect, type Page, test } from '@playwright/test';
import { connect } from '../../packages/server/src/db';
import {
  audit,
  emailedLink,
  person,
  scriptsHeld,
  showSource,
  signIn,
  sticksOut,
  typingSaved,
} from './helpers';
import { enlarged, lost, spaced } from './look';

type Person = Awaited<ReturnType<typeof person>>;
const ON = process.env.VERSIONS === '1';
const VERSION = 'camera-ready';
const OF = `“${VERSION}”`;
const source = (page: Page) => page.locator('.editor .cm-content');
const editorStatus = (page: Page) =>
  page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
const said = (page: Page) => page.locator('.merge-said [role=status], .merge-said [role=alert]');
const into = (page: Page) => page.getByRole('button', { name: 'Merge into main', exact: true });
const upToDate = (page: Page) =>
  page.getByRole('button', { name: 'Bring up to date from main', exact: true });
const mergeAt = (paper: string, version: string, up = false) =>
  `${paper}/versions/${version.split('/').pop()}/merge${up ? '?direction=up' : ''}`;
const across = (page: Page) => page.locator('#across');

/** A paper made from the article template, as its owner sees it: the address of the paper. */
async function newPaper(owner: Person) {
  const { page, email } = owner;
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Name of a new paper').fill(`Across ${Date.now().toString(36)}`);
  await page.getByLabel('Start from').selectOption({ label: 'Article' });
  await page.getByRole('button', { name: 'Create paper' }).click();
  await expect(page.getByRole('heading', { name: 'Revisions', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  return page.url().split('?')[0];
}

async function invite(owner: Person, paper: string, guest: Person, role: string) {
  await owner.page.goto(paper);
  await owner.page.getByLabel('Their email address').fill(guest.email);
  await owner.page.getByLabel('Their role').selectOption(role);
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(guest.email);
  await guest.page.goto(await emailedLink(guest.email, '/invitations/'));
  await signIn(guest.page, guest.email);
  await guest.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(guest.page.getByText(/You are an? /)).toBeVisible();
}

/** Start a version from the paper as it is now; its address. */
async function startVersion(page: Page, paper: string, name = VERSION) {
  await page.goto(`${paper}/history`);
  await page.getByRole('button', { name: 'Start a version', exact: true }).click();
  await page.getByLabel('Name for the version').fill(name);
  await page.getByRole('button', { name: 'Start the version' }).click();
  await expect(page.locator('.history-said [role=status]')).toContainText(
    `Started the version “${name}”.`,
  );
  const href = (await page.getByRole('link', { name: 'Open the version' }).getAttribute('href'))!;
  return `${new URL(page.url()).origin}${href}`;
}

/** Type at the start or the end of a text file of a paper (or a version of it), and let it save. */
async function typeIn(
  page: Page,
  paper: string,
  text: string,
  where: 'start' | 'end',
  file = 'main.tex',
) {
  await page.goto(paper);
  await page.getByRole('link', { name: file }).first().click();
  await showSource(page);
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  await source(page).click();
  await page.keyboard.press(where === 'start' ? 'ControlOrMeta+Home' : 'ControlOrMeta+End');
  await page.keyboard.type(text);
  await typingSaved(page);
}

async function addFile(page: Page, paper: string, name: string) {
  await page.goto(paper);
  await page.getByLabel('Name, with folders if you like').fill(name);
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByRole('status')).toHaveText(`Added ${name}.`);
}

/** Rename a file of a paper (or a version) from its page. */
async function rename(page: Page, paper: string, from: string, to: string) {
  await page.goto(paper);
  const row = page.getByRole('row', { name: new RegExp(`^${from.replace('.', '\\.')}`) });
  await row.locator('summary').click();
  await row.getByLabel(`New name for ${from}`).fill(to);
  await row.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('link', { name: to })).toBeVisible();
}

/** The two steps of comparing with another paper of the family, from the history page. */
async function compareWith(
  page: Page,
  name: string,
  opts: { mine?: string; theirs?: string } = {},
) {
  await across(page).getByLabel('Another version, or main').selectOption({ label: name });
  await across(page).getByRole('button', { name: 'Choose its revisions' }).click();
  await expect(page).toHaveURL(/[?&]across=/);
  if (opts.mine)
    await across(page)
      .getByLabel(/^Revision of /)
      .first()
      .selectOption(opts.mine);
  if (opts.theirs)
    await across(page)
      .getByLabel(/^Revision of /)
      .last()
      .selectOption(opts.theirs);
  await across(page).getByRole('button', { name: 'Show the changes across versions' }).click();
}

/** Merge the version into main (or main into the version) from the merge page, as it stands. */
async function merge(page: Page, paper: string, version: string, up = false) {
  await page.goto(mergeAt(paper, version, up));
  await (up ? upToDate(page) : into(page)).click();
  await expect(said(page)).toContainText('Merged:');
}

if (ON) {
  test('history: a merge is a row of its own, with who, when, what into what, and the conflicts', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const owner = await person(browser, 'hv-merge-owner');
    const { page } = owner;
    const paper = await newPaper(owner);
    const version = await startVersion(page, paper);

    // A merge that fits together.
    await typeIn(page, paper, '% a note on main\n', 'start');
    await typeIn(page, version, '% a note on the version\n', 'end');
    await merge(page, paper, version);
    await page.goto(`${paper}/history`);
    const row = page.locator('.history-merge').first();
    await expect(row).toBeVisible();
    await expect(row.locator('.history-name')).toHaveText(`Merged ${OF} into main`);
    await expect(row).toContainText(`by ${owner.email}`);
    await expect(row).toContainText('1 file merged, 0 conflicts decided.');
    await expect(row.locator('.history-number')).toHaveText(/^Revision \d+$/);
    await audit(page, 'the history page with a merge row');
    // It leads to the comparison with what it replaced, which is main as it stood before.
    await row.getByRole('link', { name: 'Compare with what it replaced' }).click();
    await expect(page).toHaveURL(/\/revisions\/[0-9a-f-]+\/diff\/[0-9a-f-]+$/);
    await expect(page.getByText('% a note on the version')).toBeVisible();

    // A conflict decided: the same sentence in both, and one choice.
    await typeIn(page, paper, '% main, second\n', 'start');
    await typeIn(page, version, '% version, second\n', 'start');
    await page.goto(mergeAt(paper, version));
    await page.getByRole('radio', { name: `Take the text on the version ${OF}` }).check();
    await into(page).click();
    await expect(said(page)).toContainText('1 conflict decided');
    await page.goto(`${paper}/history`);
    await expect(page.locator('.history-merge')).toHaveCount(2);
    await expect(page.locator('.history-merge').first()).toContainText(
      '1 file merged, 1 conflict decided.',
    );

    // The other way round, in the version's own timeline.
    await typeIn(page, paper, '% main, third\n', 'end');
    await merge(page, paper, version, true);
    await page.goto(`${version}/history`);
    const back = page.locator('.history-merge').first();
    await expect(back.locator('.history-name')).toHaveText(`Merged main into ${OF}`);
    await expect(back).toContainText('1 file merged, 0 conflicts decided.');
    // The merge into main is not a row of the version's timeline.
    await expect(page.locator('.history-merge')).toHaveCount(1);

    // At 320 px, with text spaced and at twice the size.
    await page.goto(`${paper}/history`);
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await sticksOut(page)).toEqual([]);
    await audit(page, 'the history page with merge rows at 320 px');
    await page.setViewportSize({ width: 1280, height: 720 });
    await spaced(page);
    expect(await lost(page)).toEqual([]);
    await page.goto(`${paper}/history`);
    await enlarged(page);
    expect(await lost(page)).toEqual([]);
  });

  test('history: compare a revision of this paper with one of its version, files paired by origin', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const owner = await person(browser, 'hv-across-owner');
    const { page } = owner;
    const paper = await newPaper(owner);
    await addFile(page, paper, 'notes.tex');
    await typeIn(page, paper, 'first line\n', 'start', 'notes.tex');
    const version = await startVersion(page, paper);
    // The version renames the file and edits it, and adds one; main edits its own main.tex.
    await typeIn(page, version, 'second line, on the version\n', 'end', 'notes.tex');
    await rename(page, version, 'notes.tex', 'chapter.tex');
    await addFile(page, version, 'extra.tex');
    await typeIn(page, paper, '% only on main\n', 'start');

    await page.goto(`${paper}/history`);
    await expect(across(page).getByRole('heading', { level: 3 })).toHaveText(
      'Compare with another version',
    );
    // Before anything is chosen there is only the choice of the other paper.
    await expect(across(page).getByLabel(/^Revision of /)).toHaveCount(0);
    await compareWith(page, VERSION);
    const result = across(page).getByRole('heading', { level: 4 });
    await expect(result).toHaveText(
      new RegExp(`^Revision \\d+ of main to revision \\d+ of ${OF}$`),
    );
    // One file renamed and changed: the same file, by its origin, not a removal and an addition.
    const chapter = across(page).getByRole('region', { name: 'chapter.tex', exact: true });
    await expect(chapter).toContainText('Changed');
    await expect(chapter).toContainText('(was notes.tex)');
    await expect(
      chapter.getByRole('region', { name: 'Changes to chapter.tex', exact: true }),
    ).toContainText('second line, on the version');
    await expect(
      across(page).getByRole('region', { name: 'extra.tex', exact: true }),
    ).toContainText('Added');
    await expect(across(page).getByRole('region', { name: 'main.tex', exact: true })).toContainText(
      '% only on main',
    );
    await expect(across(page).getByRole('region', { name: 'notes.tex', exact: true })).toHaveCount(
      0,
    );
    await audit(page, 'the history page comparing across versions');

    // The address holds the comparison, and the two lists keep their choices.
    await page.reload();
    await expect(across(page).getByRole('heading', { level: 4 })).toHaveText(
      new RegExp(`of ${OF}$`),
    );
    await expect(across(page).getByLabel(`Another version, or main`)).toHaveValue(
      /^[0-9a-f-]{36}$/,
    );

    // From the version's side, main is the other paper; an earlier revision of main is chosen.
    await page.goto(`${version}/history`);
    const mine = across(page).getByLabel('Another version, or main');
    await expect(mine.locator('option')).toHaveText(['main']);
    await compareWith(page, 'main');
    await expect(across(page).getByRole('heading', { level: 4 })).toHaveText(
      new RegExp(`^Revision \\d+ of ${OF} to revision \\d+ of main$`),
    );
    await expect(
      across(page).getByRole('region', { name: 'notes.tex', exact: true }),
    ).toContainText('(was chapter.tex)');

    // At 320 px, and with no scripts: plain forms.
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await sticksOut(page)).toEqual([]);
    await audit(page, 'the history page comparing across versions at 320 px');
    await page.setViewportSize({ width: 1280, height: 720 });
    const release = await scriptsHeld(page);
    await page.goto(`${paper}/history`, { waitUntil: 'domcontentloaded' });
    await compareWith(page, VERSION);
    await expect(across(page).getByRole('heading', { level: 4 })).toBeVisible();
    release();
    await spaced(page);
    expect(await lost(page)).toEqual([]);
  });

  test('history: who may compare across versions and see merges: owner, editor, reviewer, viewer, stranger, and a member of one paper only', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const owner = await person(browser, 'hv-roles-owner');
    const editor = await person(browser, 'hv-roles-editor');
    const reviewer = await person(browser, 'hv-roles-reviewer');
    const viewer = await person(browser, 'hv-roles-viewer');
    const stranger = await person(browser, 'hv-roles-stranger');
    const partial = await person(browser, 'hv-roles-partial');
    const paper = await newPaper(owner);
    await invite(owner, paper, editor, 'editor');
    await invite(owner, paper, reviewer, 'reviewer');
    await invite(owner, paper, viewer, 'viewer');
    await invite(owner, paper, partial, 'viewer');
    await stranger.page.goto('/sign-in');
    await signIn(stranger.page, stranger.email);
    const version = await startVersion(owner.page, paper);
    await typeIn(owner.page, paper, '% a note on main\n', 'start');
    await typeIn(owner.page, version, '% a note on the version\n', 'end');
    await merge(owner.page, paper, version);
    await typeIn(owner.page, version, '% later, on the version\n', 'end');

    // Everyone on the paper sees the merge row and compares; only those who may make revisions
    // are offered the paper as it is now.
    for (const [who, writes] of [
      [owner, true],
      [editor, true],
      [reviewer, false],
      [viewer, false],
    ] as const) {
      const { page } = who;
      await page.goto(`${paper}/history`);
      const row = page.locator('.history-merge').first();
      await expect(row.locator('.history-name')).toHaveText(`Merged ${OF} into main`);
      await expect(row).toContainText('1 file merged, 0 conflicts decided.');
      await expect(row.getByRole('link', { name: 'Compare with what it replaced' })).toBeVisible();
      await across(page).getByLabel('Another version, or main').selectOption({ label: VERSION });
      await across(page).getByRole('button', { name: 'Choose its revisions' }).click();
      const lists = across(page).getByLabel(/^Revision of /);
      await expect(lists).toHaveCount(2);
      for (const list of await lists.all())
        await expect(list.locator('option', { hasText: 'The paper as it is now' })).toHaveCount(
          writes ? 1 : 0,
        );
      await across(page).getByRole('button', { name: 'Show the changes across versions' }).click();
      await expect(across(page).getByRole('heading', { level: 4 })).toHaveText(
        new RegExp(`^Revision \\d+ of main to revision \\d+ of ${OF}$`),
      );
      await audit(
        page,
        `the comparison across versions for the ${who === owner ? 'owner' : 'others'}`,
      );
    }

    // What the person with a view would be sent, kept for the stranger and the partial member.
    const there = across(owner.page).locator('#across-theirs option');
    const theirs = (await there.last().getAttribute('value'))!;
    const mineOf = across(owner.page).locator('#across-mine option');
    const mine = (await mineOf.last().getAttribute('value'))!;
    const id = (url: string) => url.split('/projects/')[1].split(/[/?#]/)[0];
    const asked = `?across=${id(version)}&mine=${mine}&theirs=${theirs}`;

    // A stranger: the paper, its version and the comparison are not there.
    expect((await stranger.page.goto(`${paper}/history`))!.status()).toBe(404);
    expect((await stranger.page.goto(`${paper}/history${asked}`))!.status()).toBe(404);
    expect((await stranger.page.goto(`${version}/history`))!.status()).toBe(404);

    // A member of the paper who is not on the version (the people of a version are copied from its
    // paper, so this is made here by hand): the version is listed with the paper, but nothing of it
    // opens, the comparison is refused, and the merge row does not say which version it was.
    const pool = connect(
      process.env.DATABASE_URL ?? 'postgres://paperweave:paperweave@localhost:5432/paperweave',
    );
    try {
      await pool.query(
        `delete from project_members
         where project_id = $1 and user_id = (select id from "user" where email = $2)`,
        [id(version), partial.email],
      );
    } finally {
      await pool.end();
    }
    const { page } = partial;
    expect((await page.goto(`${version}/history`))!.status()).toBe(404);
    expect((await page.goto(`${paper}/history`))!.status()).toBe(200);
    await expect(page.locator('.history-merge').first().locator('.history-name')).toHaveText(
      'Merged another version into main',
    );
    await across(page).getByLabel('Another version, or main').selectOption({ label: VERSION });
    await across(page).getByRole('button', { name: 'Choose its revisions' }).click();
    await expect(across(page).getByRole('alert')).toHaveText('No such paper to compare with.');
    await expect(across(page).getByLabel(/^Revision of /)).toHaveCount(0);
    // The same asked for by address: no comparison, and none of the version's text.
    await page.goto(`${paper}/history${asked}`);
    await expect(across(page).getByRole('alert')).toHaveText('No such paper to compare with.');
    await expect(across(page).getByRole('heading', { level: 4 })).toHaveCount(0);
    await expect(page.getByText('% later, on the version')).toHaveCount(0);
    await audit(page, 'the history page of a member of one paper only');
  });
} else {
  test('with VERSIONS off the history page has no merge rows and no comparing across versions', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const owner = await person(browser, 'hv-off');
    const paper = await newPaper(owner);
    const { page } = owner;
    const ghost = '00000000-0000-4000-8000-000000000000';
    await page.goto(`${paper}/history?across=${ghost}&mine=${ghost}&theirs=${ghost}`);
    await expect(page.getByRole('heading', { name: 'Revisions', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Compare with another version' })).toHaveCount(
      0,
    );
    await expect(page.locator('#across')).toHaveCount(0);
    await expect(page.getByText('No such paper to compare with.')).toHaveCount(0);
    await expect(page.locator('.history-merge')).toHaveCount(0);
  });
}
