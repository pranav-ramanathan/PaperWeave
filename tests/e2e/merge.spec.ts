// The merge page (PLAN.md section 14.2, T41): a version into main, or main into the version to
// bring it up to date. A clean merge, a conflict each way, text written by hand, the paper changed
// while the person was deciding, a picture changed on both sides, a file renamed on both sides,
// who may merge, and a page that posts without scripts. Everything is behind the `VERSIONS`
// setting: with it off the page is not there. Each group runs when its setting is the one the
// server has; none is skipped for a reason that is not the setting.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  audit,
  emailedLink,
  person,
  scriptsHeld,
  selectWord,
  showSource,
  signIn,
  sticksOut,
  typingSaved,
} from './helpers';
import { enlarged, lost, spaced } from './look';

type Person = Awaited<ReturnType<typeof person>>;
// On unless the server was started with VERSIONS=0, as versionsEnabled reads it.
const ON = process.env.VERSIONS?.trim() !== '0';
const said = (page: Page) => page.locator('.merge-said [role=status], .merge-said [role=alert]');
const source = (page: Page) => page.locator('.editor .cm-content');
const editorStatus = (page: Page) =>
  page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
const MAIN = 'main';
const VERSION = 'camera-ready';
const OF = `the version “${VERSION}”`;
const radio = (page: Page, name: string) => page.getByRole('radio', { name, exact: true });
const into = (page: Page) => page.getByRole('button', { name: 'Merge into main', exact: true });
const upToDate = (page: Page) =>
  page.getByRole('button', { name: 'Bring up to date from main', exact: true });

/** A paper made from the article template, as its owner sees it: the address of the paper. */
async function newPaper(owner: Person) {
  const { page, email } = owner;
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Name of a new paper').fill(`Merge ${Date.now().toString(36)}`);
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

const mergeAt = (paper: string, version: string, up = false) =>
  `${paper}/versions/${version.split('/').pop()}/merge${up ? '?direction=up' : ''}`;

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

async function textOf(page: Page, paper: string, file = 'main.tex') {
  await page.goto(paper);
  await page.getByRole('link', { name: file }).first().click();
  await showSource(page);
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  return source(page);
}

const png = (tag: string) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    Buffer.from(tag),
  ]);

/** Add (or replace) a picture of the paper. */
async function putPicture(page: Page, paper: string, tag: string, replace: boolean) {
  const file = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), 'pic.png');
  writeFileSync(file, png(tag));
  await page.goto(paper);
  await page.getByLabel('Name, with folders if you like').fill('pic.png');
  await page.getByLabel(/^A file to upload/).setInputFiles(file);
  if (replace) await page.getByRole('checkbox', { name: /Replace the file of this name/ }).check();
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByRole('status')).toHaveText(
    replace ? 'Replaced pic.png.' : 'Added pic.png.',
  );
}

type Sent = { headers: Record<string, string>; body: Buffer };

/** What the page sends when `press` is done, kept and not let through. */
async function sentBy(page: Page, press: () => Promise<unknown>): Promise<Sent> {
  let got!: (s: Sent) => void;
  const sent = new Promise<Sent>((r) => (got = r));
  await page.route(/\/merge/, async (route) => {
    const r = route.request();
    if (r.method() === 'POST' && r.headers()['next-action']) {
      got({ headers: r.headers(), body: r.postDataBuffer()! });
      await route.abort();
    } else await route.continue();
  });
  await press();
  const out = await sent;
  await page.unroute(/\/merge/);
  return out;
}

if (ON) {
  test('merge: clean, a conflict each way, by hand, and a paper that changed while deciding', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const owner = await person(browser, 'merge-owner');
    const { page } = owner;
    const paper = await newPaper(owner);
    const version = await startVersion(page, paper);

    // Changes that fit together: main at the start, the version at the end.
    await typeIn(page, paper, '% a note on main\n', 'start');
    await typeIn(page, version, '% a note on the version\n', 'end');
    await page.goto(mergeAt(paper, version));
    await expect(page).toHaveTitle(/^Merge · .* — PaperWeave$/);
    await expect(
      page.getByRole('heading', { level: 1, name: `Merge “${VERSION}” into main` }),
    ).toBeVisible();
    await expect(page.getByText('Changed on both, and the changes fit together.')).toBeVisible();
    await expect(page.getByRole('group', { name: /^Conflict / })).toHaveCount(0);
    await audit(page, 'the merge page with nothing to decide');
    await into(page).click();
    await expect(said(page)).toContainText('Merged: main is now revision');
    await expect(said(page)).toContainText('1 file changed and 0 conflicts decided');
    await expect(said(page)).toContainText('The paper as it was is revision');
    // The merge is done: main has both notes, and there is nothing left to merge.
    await expect(await textOf(page, paper)).toContainText('% a note on the version');
    await expect(source(page)).toContainText('% a note on main');
    await page.goto(mergeAt(paper, version));
    await expect(page.getByText(/^There is nothing to merge/)).toBeVisible();
    await expect(into(page)).toHaveCount(0);

    // A conflict into main, decided from the keyboard: the two sides write at the same place.
    await typeIn(page, paper, '% main, second\n', 'start');
    await typeIn(page, version, '% version, second\n', 'start');
    await page.goto(mergeAt(paper, version));
    const first = page.getByRole('group', { name: /^Conflict 1 of 1: main\.tex, line \d+$/ });
    await expect(first).toBeVisible();
    await expect(first.getByText(`On ${MAIN}`, { exact: true })).toBeVisible();
    await expect(first.getByText(`On ${OF}`, { exact: true })).toBeVisible();
    await expect(first.getByText('The text before either side changed it')).toBeVisible();
    await expect(first.getByRole('radio')).toHaveCount(4);
    await audit(page, 'the merge page with a conflict');
    // Neither is chosen: the browser stops the form, and nothing is merged.
    await into(page).click();
    await expect(page).toHaveURL(/\/merge$/);
    await expect(said(page)).toHaveCount(0);
    // Tab reaches the group, the arrow keys move in it, and Enter on the button sends it.
    await radio(page, `Keep the text on ${MAIN}`).focus();
    await page.keyboard.press('ArrowDown');
    await expect(radio(page, `Take the text on ${OF}`)).toBeChecked();
    await into(page).focus();
    await page.keyboard.press('Enter');
    await expect(said(page)).toContainText('1 conflict decided');
    await expect(await textOf(page, paper)).toContainText('% version, second');
    await expect(source(page)).not.toContainText('% main, second');

    // A conflict the other way: main brought up to date, the text written by hand.
    await typeIn(page, paper, '% main, third\n', 'start');
    await typeIn(page, version, '% version, third\n', 'start');
    await page.goto(mergeAt(paper, version, true));
    await expect(
      page.getByRole('heading', { level: 1, name: `Bring “${VERSION}” up to date from main` }),
    ).toBeVisible();
    const group = page.getByRole('group', { name: /^Conflict 1 of 1: main\.tex/ });
    await expect(group.getByText(`On ${OF}`, { exact: true })).toBeVisible();
    await expect(group.getByText(`On ${MAIN}`, { exact: true })).toBeVisible();
    await group.getByLabel('Your text for conflict 1').fill('% by hand, third\n');
    // Typing in the box chose "Write it myself".
    await expect(radio(page, 'Write it myself')).toBeChecked();
    await upToDate(page).click();
    await expect(said(page)).toContainText('Merged: the version “camera-ready” is now revision');
    await expect(await textOf(page, version)).toContainText('% by hand, third');
    await expect(source(page)).not.toContainText('% main, third');
    await expect(source(page)).not.toContainText('% version, third');

    // The paper changes while the person is deciding: refused, and what they chose stays chosen.
    await typeIn(page, paper, '% main, fourth\n', 'end');
    await typeIn(page, version, '% version, fourth\n', 'end');
    await page.goto(mergeAt(paper, version));
    await radio(page, `Keep both, the text on ${MAIN} first`).check();
    // Someone (here, the same person in another window) types in main.tex after the page was drawn.
    const other = await page.context().newPage();
    await typeIn(other, paper, '% typed meanwhile\n', 'start');
    await other.close();
    await into(page).click();
    await expect(said(page)).toContainText('The paper changed while you were deciding.');
    // The paper is drawn again as it is now; the choice already made is still made. What was typed
    // meanwhile may be one more thing to decide.
    const both = radio(page, `Keep both, the text on ${MAIN} first`);
    await expect(both.first()).toBeChecked();
    for (const one of await both.all()) await one.check();
    await into(page).click();
    await expect(said(page)).toContainText('Merged: main is now revision');
    const merged = await textOf(page, paper);
    await expect(merged).toContainText('% main, fourth');
    await expect(merged).toContainText('% version, fourth');
    await expect(merged).toContainText('% typed meanwhile');
  });

  test('merge: open comments are brought across when asked, once, on the same words', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const owner = await person(browser, 'merge-carry-owner');
    const { page } = owner;
    const paper = await newPaper(owner);
    const version = await startVersion(page, paper);
    await typeIn(page, version, '% bringable words\n', 'end');
    // A comment on the version, on words that the merge will bring into main.
    await page.goto(version);
    await page.getByRole('link', { name: 'main.tex' }).first().click();
    await showSource(page);
    const panel = page.getByRole('region', { name: 'Comments' });
    await selectWord(page, '.editor .cm-content', 'bringable');
    await panel.getByRole('button', { name: 'Comment on the selected text' }).click();
    await panel.getByLabel('Comment', { exact: true }).fill('Are these the right words?');
    await panel.getByRole('button', { name: 'Start thread' }).click();
    await expect(page.getByRole('article', { name: 'Thread on “bringable”' })).toBeVisible();

    await page.goto(mergeAt(paper, version));
    const carry = page.getByRole('checkbox', { name: 'Bring open comments and proposals across' });
    await expect(carry).not.toBeChecked();
    await audit(page, 'the merge page with the choice to bring comments across');
    await carry.check();
    await into(page).click();
    await expect(said(page)).toContainText('Merged: main is now revision');
    await expect(said(page)).toContainText('Brought across: 1 comment thread and 0 proposals.');

    // Main has the comment, on the same words, and the version keeps its own.
    await page.goto(paper);
    await page.getByRole('link', { name: 'main.tex' }).first().click();
    await showSource(page);
    const main = page.getByRole('region', { name: 'Comments' });
    const thread = main.getByRole('article', { name: 'Thread on “bringable”' });
    await expect(thread).toHaveCount(1);
    await expect(thread).toContainText('Are these the right words?');
    await expect(thread).toContainText(owner.email);
    await page.goto(version);
    await page.getByRole('link', { name: 'main.tex' }).first().click();
    await expect(page.getByRole('article', { name: 'Thread on “bringable”' })).toHaveCount(1);

    // Another merge does not bring it again: nothing is left to offer.
    await typeIn(page, version, '% one more note\n', 'end');
    await page.goto(mergeAt(paper, version));
    await expect(
      page.getByRole('checkbox', { name: 'Bring open comments and proposals across' }),
    ).toHaveCount(0);
    await into(page).click();
    await expect(said(page)).toContainText('Merged: main is now revision');
    await expect(said(page)).not.toContainText('Brought across');
    await page.goto(paper);
    await page.getByRole('link', { name: 'main.tex' }).first().click();
    await expect(
      page.getByRole('region', { name: 'Comments' }).getByRole('article', {
        name: 'Thread on “bringable”',
      }),
    ).toHaveCount(1);
  });

  test('merge: a picture changed on both sides, posted without scripts, and the page at 320 px', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    const owner = await person(browser, 'merge-picture');
    const { page } = owner;
    const paper = await newPaper(owner);
    await putPicture(page, paper, 'base', false);
    const version = await startVersion(page, paper);
    await putPicture(page, paper, 'main', true);
    await putPicture(page, version, 'version', true);
    await typeIn(page, paper, '% main side\n', 'start');
    await typeIn(page, version, '% version side\n', 'start');

    await page.goto(mergeAt(paper, version));
    const pic = page.getByRole('group', { name: /^Conflict \d of 2: pic\.png$/ });
    await expect(pic).toBeVisible();
    await expect(pic.getByText('is not text and was changed on both sides')).toBeVisible();
    await expect(pic.getByRole('radio')).toHaveCount(2);
    const text = page.getByRole('group', { name: /^Conflict \d of 2: main\.tex, line \d+$/ });
    await expect(text).toBeVisible();
    await audit(page, 'the merge page with a picture and a text conflict');
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await sticksOut(page)).toEqual([]);
    await audit(page, 'the merge page at 320 px');
    await page.setViewportSize({ width: 1280, height: 720 });
    await spaced(page);
    expect(await lost(page)).toEqual([]);
    await page.goto(mergeAt(paper, version));
    await enlarged(page);
    expect(await lost(page)).toEqual([]);

    // Without scripts: the radios and the box are plain controls, and the form posts as it is.
    const release = await scriptsHeld(page);
    await page.goto(mergeAt(paper, version), { waitUntil: 'domcontentloaded' });
    await radio(page, `Keep the file on ${MAIN}`).check();
    await radio(page, 'Write it myself').check();
    await page.getByLabel(/^Your text for conflict \d/).fill('% written with no scripts\n');
    await into(page).click();
    await expect(said(page)).toContainText('2 conflicts decided');
    release();
    await expect(await textOf(page, paper)).toContainText('% written with no scripts');
    // Main kept its picture: the file on this side was chosen.
    await page.goto(paper);
    await expect(page.getByRole('row', { name: /^pic\.png/ })).toBeVisible();
  });

  test('merge: a file renamed on both sides and edited on both says what is left behind', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    const owner = await person(browser, 'merge-renamed');
    const { page } = owner;
    const paper = await newPaper(owner);
    await page.goto(paper);
    await page.getByLabel('Name, with folders if you like').fill('notes.tex');
    await page.getByRole('button', { name: 'Add file' }).click();
    await expect(page.getByRole('status')).toHaveText('Added notes.tex.');
    await typeIn(page, paper, 'first line\n', 'start', 'notes.tex');
    const version = await startVersion(page, paper);
    for (const [where, name, line] of [
      [paper, 'on-main.tex', 'main edit\n'],
      [version, 'on-version.tex', 'version edit\n'],
    ] as const) {
      await typeIn(page, where, line, 'end', 'notes.tex');
      await page.goto(where);
      const row = page.getByRole('row', { name: /^notes\.tex/ });
      await row.locator('summary').click();
      await row.getByLabel('New name for notes.tex').fill(name);
      await row.getByRole('button', { name: 'Rename' }).click();
      await page.getByRole('button', { name: 'Rename', exact: true }).click();
      await expect(page.getByRole('link', { name })).toBeVisible();
    }
    await page.goto(mergeAt(paper, version));
    const card = page.getByRole('group', { name: /^Conflict 1 of 1: on-main\.tex$/ });
    await expect(card).toBeVisible();
    await expect(
      card.getByText('renamed differently on both sides and edited on both'),
    ).toBeVisible();
    await expect(card.getByText('The edits of the other side are not carried')).toBeVisible();
    await expect(
      page.getByText('on-main.tex was renamed differently on both sides and edited on both.'),
    ).toBeVisible();
    await audit(page, 'the merge page with a rename on both sides');
    await radio(page, 'Keep the name on-main.tex').check();
    await into(page).click();
    await expect(said(page)).toContainText('Merged: main is now revision');
    await page.goto(paper);
    await expect(page.getByRole('link', { name: 'on-main.tex' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'on-version.tex' })).toHaveCount(0);
  });

  test('merge: who may start and apply one: owner, editor, reviewer, viewer, stranger', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const owner = await person(browser, 'merge-roles-owner');
    const editor = await person(browser, 'merge-roles-editor');
    const reviewer = await person(browser, 'merge-roles-reviewer');
    const viewer = await person(browser, 'merge-roles-viewer');
    const stranger = await person(browser, 'merge-roles-stranger');
    const paper = await newPaper(owner);
    await invite(owner, paper, editor, 'editor');
    await invite(owner, paper, reviewer, 'reviewer');
    await invite(owner, paper, viewer, 'viewer');
    await stranger.page.goto('/sign-in');
    await signIn(stranger.page, stranger.email);
    const version = await startVersion(owner.page, paper);
    await typeIn(owner.page, paper, '% a note on main\n', 'start');
    await typeIn(owner.page, version, '% a note on the version\n', 'end');
    const at = mergeAt(paper, version);
    const upAt = mergeAt(paper, version, true);

    // What applying sends, taken from the owner's own page (and not let through).
    const side = await (
      await browser.newContext({
        storageState: await owner.page.context().storageState(),
        extraHTTPHeaders: { 'x-forwarded-for': '10.9.9.9' },
      })
    ).newPage();
    await side.goto(at);
    const apply = await sentBy(side, () => into(side).click());
    await side.goto(upAt);
    const bring = await sentBy(side, () => upToDate(side).click());
    await side.context().close();

    const send = (who: Person, to: string, what: Sent) => {
      const headers = Object.fromEntries(
        Object.entries(what.headers).filter(
          ([k]) => !['cookie', 'host', 'content-length'].includes(k),
        ),
      );
      return who.page.request.post(to, { headers, data: what.body, maxRedirects: 0 });
    };
    const redirect = (res: Awaited<ReturnType<typeof send>>) =>
      decodeURIComponent(res.headers()['x-action-redirect'] ?? '');

    // Reviewer and viewer: the page tells them who may, offers no form, and the same requests sent
    // by hand are refused, both ways.
    for (const who of [reviewer, viewer]) {
      for (const where of [at, upAt]) {
        await who.page.goto(where);
        await expect(
          who.page.getByText('Only the owner and the editors of a paper can merge its versions.'),
        ).toBeVisible();
        await expect(into(who.page)).toHaveCount(0);
        await expect(upToDate(who.page)).toHaveCount(0);
      }
      await audit(who.page, 'the merge page for someone who may not merge');
      expect(redirect(await send(who, at, apply)), 'merge sent by hand').toContain('error=');
      expect(redirect(await send(who, upAt, bring)), 'update sent by hand').toContain('error=');
      // The switcher offers them no way to it.
      await who.page.goto(`${version}/history`);
      await who.page.getByRole('button', { name: `Version: ${VERSION}` }).click();
      await expect(who.page.getByRole('menuitem', { name: 'Merge into main' })).toHaveCount(0);
      await who.page.keyboard.press('Escape');
    }

    // The stranger: nothing is there, and the same requests find nothing.
    expect((await stranger.page.goto(at))!.status()).toBe(404);
    expect((await stranger.page.goto(upAt))!.status()).toBe(404);
    expect((await send(stranger, at, apply)).status()).toBe(404);
    expect((await send(stranger, upAt, bring)).status()).toBe(404);

    // The editor is offered it, and applies it.
    await editor.page.goto(`${version}/history`);
    await editor.page.getByRole('button', { name: `Version: ${VERSION}` }).click();
    await expect(editor.page.getByRole('menuitem', { name: 'Merge into main' })).toBeVisible();
    await expect(
      editor.page.getByRole('menuitem', { name: 'Bring up to date from main' }),
    ).toBeVisible();
    await editor.page.keyboard.press('Escape');
    await editor.page.goto(at);
    await expect(into(editor.page)).toBeVisible();
    expect(redirect(await send(editor, at, apply)), 'merge sent by the editor').toContain(
      'merged=',
    );

    // The owner's request is out of date now: the version was merged since it was looked at.
    expect(redirect(await send(owner, at, apply)), 'the same merge again').toContain('error=');
    await owner.page.goto(at);
    await expect(owner.page.getByText(/^There is nothing to merge/)).toBeVisible();
    await owner.page.goto(`${version}/history`);
    await owner.page.getByRole('button', { name: `Version: ${VERSION}` }).click();
    await expect(owner.page.getByRole('menuitem', { name: 'Merge into main' })).toBeVisible();
    await owner.page.keyboard.press('Escape');
    // The list on the history page leads to it as well.
    await owner.page.goto(`${paper}/history`);
    await owner.page.getByRole('button', { name: `More for version ${VERSION}` }).click();
    await owner.page.getByRole('menuitem', { name: 'Merge into main' }).click();
    await expect(owner.page).toHaveURL(at);
  });
  // What an open editor says of a merge, as it does of a restore (T42): who merged what into
  // which paper, the way to the comparison and to the history, Dismiss, and the same after an
  // offline spell. A reload is not told again.
  test('a merge is said in the editor of the paper it changed', async ({ browser }) => {
    test.setTimeout(600_000);
    const owner = await person(browser, 'merge-told-owner');
    const editor = await person(browser, 'merge-told-editor');
    const paper = await newPaper(owner);
    await invite(owner, paper, editor, 'editor');
    const version = await startVersion(owner.page, paper);
    const notice = (page: Page) => page.locator('.editor-notice');
    const open = async (page: Page, where: string) => {
      await page.goto(where);
      await page.getByRole('link', { name: 'main.tex' }).first().click();
      await showSource(page);
      await expect(editorStatus(page)).toHaveText('All edits saved.');
      await expect(source(page)).toHaveAttribute('contenteditable', 'true');
    };

    // Main is open; a version that changed the file is merged into it by someone else.
    await open(editor.page, paper);
    await expect(notice(editor.page)).toHaveCount(0);
    await typeIn(owner.page, version, '% a note on the version\n', 'end');
    await owner.page.goto(mergeAt(paper, version));
    await into(owner.page).click();
    await expect(said(owner.page)).toContainText('Merged: main is now revision');
    await expect(source(editor.page)).toContainText('% a note on the version');
    const words = notice(editor.page).locator('[aria-live]');
    await expect(words).toContainText(`${owner.email} merged ${OF} into this paper at `);
    const text = (await words.textContent()) ?? '';
    const now = Number(/It is now revision (\d+)\./.exec(text)?.[1]);
    expect(text).toContain(`The paper as it was is revision ${now - 1}.`);
    expect(text).not.toContain('restored');
    await expect(notice(editor.page)).toBeInViewport();
    await expect(notice(editor.page).getByRole('group', { name: 'About the merge' })).toBeVisible();
    await audit(editor.page, 'an editor told of a merge');
    // Its history is the paper's history, opened on the merge's comparison.
    await expect(
      notice(editor.page).getByRole('link', { name: /^History of this paper/ }),
    ).toHaveAttribute('href', /\/history\?from=[0-9a-f-]{36}&to=[0-9a-f-]{36}$/);
    const [changes] = await Promise.all([
      editor.page.context().waitForEvent('page'),
      notice(editor.page)
        .getByRole('link', { name: /^Show what the merge changed/ })
        .click(),
    ]);
    await expect(
      changes.getByRole('heading', { level: 1, name: `Revision ${now - 1} to revision ${now}` }),
    ).toBeVisible();
    await expect(changes.getByText('% a note on the version')).toBeVisible();
    await changes.close();
    // Dismissed, it is gone and the keyboard is back in the text.
    await notice(editor.page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice(editor.page)).toHaveCount(0);
    await expect(source(editor.page)).toBeFocused();
    // The owner, who made it, is told in their own words; a reload is told nothing.
    await editor.page.reload();
    await expect(editorStatus(editor.page)).toHaveText('All edits saved.');
    await expect(notice(editor.page)).toHaveCount(0);

    // Offline with nothing unsent while main is brought into the version: on return the text has
    // changed and the editor says so, once.
    await typeIn(owner.page, paper, '% main again\n', 'start');
    await open(editor.page, version);
    await editor.page.context().setOffline(true);
    await expect(editorStatus(editor.page)).toContainText('Offline.');
    await owner.page.goto(mergeAt(paper, version, true));
    await upToDate(owner.page).click();
    await expect(said(owner.page)).toContainText('Merged');
    await editor.page.context().setOffline(false);
    await expect(editorStatus(editor.page)).toHaveText('All edits saved.', { timeout: 30_000 });
    await expect(source(editor.page)).toContainText('% main again');
    await expect(notice(editor.page).locator('[aria-live]')).toContainText(
      `${owner.email} merged the main paper into this version at `,
    );
    await expect(notice(editor.page)).toHaveCount(1);
    await notice(editor.page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice(editor.page)).toHaveCount(0);

    // Offline with an edit of their own unsent while main is brought into the version again: the
    // edit is held, as it is across a restore, and the words say it was a merge that came.
    await typeIn(owner.page, paper, '% main once more\n', 'start');
    await source(editor.page).click();
    await editor.page.context().setOffline(true);
    await expect(editorStatus(editor.page)).toContainText('Offline.');
    await editor.page.keyboard.press('ControlOrMeta+Home');
    await editor.page.keyboard.type('% typed offline\n');
    await owner.page.goto(mergeAt(paper, version, true));
    await upToDate(owner.page).click();
    await expect(said(owner.page)).toContainText('Merged');
    await editor.page.context().setOffline(false);
    await expect(editorStatus(editor.page)).toContainText('changed by a merge', {
      timeout: 30_000,
    });
    await expect(editorStatus(editor.page)).toContainText('not saved');
    await expect(editorStatus(editor.page)).not.toContainText('restored');
    await expect(
      editor.page.getByRole('button', { name: 'Apply my edits to the merged paper' }),
    ).toBeVisible();
    await expect(editor.page.getByRole('button', { name: /restored paper/ })).toHaveCount(0);
    await editor.page.getByRole('button', { name: 'Apply my edits to the merged paper' }).click();
    await expect(editorStatus(editor.page)).toHaveText('All edits saved.', { timeout: 30_000 });
    await expect(source(editor.page)).toContainText('% typed offline');
  });
} else {
  test('with VERSIONS off there is no merge page', async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await person(browser, 'merge-off');
    const paper = await newPaper(owner);
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect((await owner.page.goto(`${paper}/versions/${ghost}/merge`))!.status()).toBe(404);
    expect((await owner.page.goto(`${paper}/versions/${ghost}/merge?direction=up`))!.status()).toBe(
      404,
    );
  });
}
