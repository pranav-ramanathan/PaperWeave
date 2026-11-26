// Versions in the pages (PLAN.md section 14.2, T39): the switcher, the list on the history page,
// starting a version from a revision or from the paper as it is, renaming, deleting, and who may do
// which. A version is a paper of its own that was begun at one of main's revisions. Everything is
// behind the `VERSIONS` setting, which is on unless the server was started with VERSIONS=0 (the
// versions-off step of the browser job in ci.yml is). So there are two groups of tests: with the setting on, what
// versions do; with it off, that nothing of them shows. Each group runs when its setting is the
// one the server has; none is skipped for a reason that is not the setting.
import { expect, type Page, test } from '@playwright/test';
import { audit, emailedLink, person, signIn, sticksOut } from './helpers';
import { enlarged, lost, spaced } from './look';

type Person = Awaited<ReturnType<typeof person>>;
// On unless the server was started with VERSIONS=0, as versionsEnabled reads it.
const ON = process.env.VERSIONS?.trim() !== '0';
const said = (page: Page) =>
  page.locator('.history-said [role=status], .history-said [role=alert]');
const numberIn = (text: string) => Number(/(\d+)/.exec(text)![1]);

/** A paper made from the article template, as its owner sees it: the address of the paper. */
async function newPaper(owner: Person) {
  const { page, email } = owner;
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Name of a new paper').fill(`Versions ${Date.now().toString(36)}`);
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
  return numberIn(await said(page).innerText());
}

async function join(owner: Person, paper: string, guest: Person, role: string) {
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

/** Start a version from the "Start a version" button, from the paper as it is now. */
async function startNow(page: Page, paper: string, name: string) {
  await page.goto(`${paper}/history`);
  await page.getByRole('button', { name: 'Start a version', exact: true }).click();
  await page.getByLabel('Name for the version').fill(name);
  await page.getByRole('button', { name: 'Start the version' }).click();
  await expect(said(page)).toContainText(`Started the version “${name}”.`);
}

if (ON) {
  test('versions: start from a revision, switch, edit apart, rename, delete', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const owner = await person(browser, 'ver-owner');
    const { page } = owner;
    const paper = await newPaper(owner);
    await addFile(page, paper, 'notes.tex');
    const submitted = await saveNamed(page, paper, 'Submitted');

    // Nothing yet: main alone, and the way to start one.
    await expect(page.getByRole('heading', { level: 2, name: 'Versions' })).toBeVisible();
    await expect(page.getByText('This paper has no versions yet.')).toBeVisible();
    await expect(page.getByText('0 versions of at most 10.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'main', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // Start one at a named revision, from that row's menu.
    await page.getByRole('button', { name: `More for revision ${submitted}` }).click();
    await page.getByRole('menuitem', { name: 'Start a version from here' }).click();
    await expect(
      page.getByRole('heading', { name: `Start a version from revision ${submitted}` }),
    ).toBeVisible();
    await page.getByLabel('Name for the version').fill('camera-ready');
    await page.getByRole('button', { name: 'Start the version' }).click();
    await expect(said(page)).toContainText('Started the version “camera-ready”.');
    const list = page.locator('.history-vlist');
    await expect(list.getByRole('link', { name: 'camera-ready' })).toBeVisible();
    await expect(list).toContainText(`Began at revision ${submitted}`);
    await expect(page.getByText('1 version of at most 10.')).toBeVisible();
    // The revision it began at says so, and leads to the version's history.
    const row = page.locator('.history-named', { hasText: 'Submitted' });
    await expect(row).toContainText('The version camera-ready began here');

    // Open it: a paper of its own, with the files of the revision, and the switcher says where.
    await page.getByRole('link', { name: 'Open the version' }).click();
    await expect(page.getByRole('button', { name: 'Version: camera-ready' })).toBeVisible();
    const version = page.url().split('?')[0];
    expect(version).not.toBe(paper);
    await expect(page.getByText('notes.tex').first()).toBeVisible();

    // Edit apart: a file added here is not on main.
    await addFile(page, version, 'only-here.tex');
    await page.goto(paper);
    await expect(page.getByRole('button', { name: 'Version: main' })).toBeVisible();
    await expect(page.getByText('notes.tex').first()).toBeVisible();
    await expect(page.getByText('only-here.tex')).toHaveCount(0);

    // Switch with the menu, on the paper page and on the history page.
    await page.getByRole('button', { name: 'Version: main' }).click();
    await expect(page.getByRole('menuitem', { name: /^main/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await page.getByRole('menuitem', { name: 'camera-ready' }).click();
    await expect(page).toHaveURL(version);
    await expect(page.getByText('only-here.tex').first()).toBeVisible();
    await page.goto(`${paper}/history`);
    await page.getByRole('button', { name: 'Version: main' }).click();
    await page.getByRole('menuitem', { name: 'camera-ready' }).click();
    await expect(page).toHaveURL(`${version}/history`);
    // On the version: both listed, this one marked, and no version of a version.
    await expect(page.getByRole('link', { name: 'camera-ready', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('link', { name: 'main', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start a version', exact: true })).toHaveCount(0);
    const own = await saveNamed(page, version, 'Own revision');
    await page.getByRole('button', { name: `More for revision ${own}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Start a version from here' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // From the paper as it is now; rename; a wrong name refuses the delete; the right one deletes.
    await startNow(page, paper, 'second');
    await page.getByRole('button', { name: 'More for version second', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByLabel('New name for second').fill('second-draft');
    await page.getByRole('button', { name: 'Save the name' }).click();
    await expect(said(page)).toHaveText('The version is now called “second-draft”.');
    await page.getByRole('button', { name: 'More for version second-draft' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByLabel('Type the name of the version, second-draft').fill('nope');
    await page.getByRole('button', { name: 'Delete the version' }).click();
    await expect(said(page)).toContainText('not the name of this version');
    await expect(page.locator('.history-vlist').getByText('second-draft')).toBeVisible();
    await page.getByRole('button', { name: 'More for version second-draft' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByLabel('Type the name of the version, second-draft').fill('second-draft');
    await page.getByRole('button', { name: 'Delete the version' }).click();
    await expect(said(page)).toHaveText('Deleted the version “second-draft”.');
    await expect(page.locator('.history-vlist').getByText('second-draft')).toHaveCount(0);

    // A name is one to a paper, and not "main".
    await page.getByRole('button', { name: 'Start a version', exact: true }).click();
    await page.getByLabel('Name for the version').fill('Camera-Ready');
    await page.getByRole('button', { name: 'Start the version' }).click();
    await expect(said(page)).toContainText('already has a version of that name');
    await page.getByRole('button', { name: 'Start a version', exact: true }).click();
    await page.getByLabel('Name for the version').fill('main');
    await page.getByRole('button', { name: 'Start the version' }).click();
    await expect(said(page)).toContainText('"main" is the name of the paper itself');

    // Deleting the version one is looking at leads back to main.
    await page.goto(`${version}/history`);
    await page.getByRole('button', { name: 'More for version camera-ready' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByLabel('Type the name of the version, camera-ready').fill('camera-ready');
    await page.getByRole('button', { name: 'Delete the version' }).click();
    await expect(page).toHaveURL(new RegExp(`${paper}/history\\?deleted=`));
    await expect(said(page)).toHaveText('Deleted the version “camera-ready”.');
    await expect(page.getByText('This paper has no versions yet.')).toBeVisible();
    // The version's address is gone for good.
    expect((await page.goto(version))!.status()).toBe(404);
  });

  type Sent = { headers: Record<string, string>; body: Buffer };

  /** What the page sends when `press` is done, kept and not let through. */
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

  test('who may do what with versions: owner, editor, reviewer, viewer, stranger', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    const owner = await person(browser, 'ver-roles-owner');
    const editor = await person(browser, 'ver-roles-editor');
    const reviewer = await person(browser, 'ver-roles-reviewer');
    const viewer = await person(browser, 'ver-roles-viewer');
    const stranger = await person(browser, 'ver-roles-stranger');
    const paper = await newPaper(owner);
    const history = `${paper}/history`;
    await join(owner, paper, editor, 'editor');
    await join(owner, paper, reviewer, 'reviewer');
    await join(owner, paper, viewer, 'viewer');
    await stranger.page.goto('/sign-in');
    await signIn(stranger.page, stranger.email);
    await startNow(owner.page, paper, 'kept');
    const kept = (await owner.page
      .getByRole('link', { name: 'Open the version' })
      .getAttribute('href'))!;

    // What each action sends, taken from the owner's own page (and not let through).
    const side = await (
      await browser.newContext({
        storageState: await owner.page.context().storageState(),
        extraHTTPHeaders: { 'x-forwarded-for': '10.9.9.9' },
      })
    ).newPage();
    await side.goto(history);
    const start = await sentBy(side, async () => {
      await side.getByRole('button', { name: 'Start a version', exact: true }).click();
      await side.getByLabel('Name for the version').fill('by-hand');
      await side.getByRole('button', { name: 'Start the version' }).click();
    });
    await side.goto(history);
    await side.getByRole('button', { name: 'More for version kept' }).click();
    await side.getByRole('menuitem', { name: 'Rename' }).click();
    const rename = await sentBy(side, async () => {
      await side.getByLabel('New name for kept').fill('renamed-by-hand');
      await side.getByRole('button', { name: 'Save the name' }).click();
    });
    await side.goto(history);
    await side.getByRole('button', { name: 'More for version kept' }).click();
    await side.getByRole('menuitem', { name: 'Delete' }).click();
    const remove = await sentBy(side, async () => {
      await side.getByLabel('Type the name of the version, kept').fill('kept');
      await side.getByRole('button', { name: 'Delete the version' }).click();
    });
    await side.context().close();

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

    // Reviewer and viewer: see the list and the switcher, and are offered no way to change it; the
    // service refuses the same actions sent by hand.
    for (const who of [reviewer, viewer]) {
      await who.page.goto(history);
      await expect(who.page.getByRole('heading', { level: 2, name: 'Versions' })).toBeVisible();
      await expect(
        who.page.locator('.history-vlist').getByRole('link', { name: 'kept' }),
      ).toBeVisible();
      await expect(who.page.getByRole('button', { name: 'Version: main' })).toBeVisible();
      await expect(
        who.page.getByRole('button', { name: 'Start a version', exact: true }),
      ).toHaveCount(0);
      await expect(who.page.getByRole('button', { name: 'More for version kept' })).toHaveCount(0);
      await audit(who.page, 'the history page of a reviewer or viewer, with a version');
      for (const [what, sent] of [
        ['start', start],
        ['rename', rename],
        ['delete', remove],
      ] as const)
        expect(redirect(await send(who, sent)), `${what} sent by hand`).toContain('error=');
      // They can look at the version's paper.
      await who.page.goto(kept);
      await expect(who.page.getByRole('button', { name: 'Version: kept' })).toBeVisible();
    }

    // The stranger: nothing is there, and the same requests find nothing.
    expect((await stranger.page.goto(history))!.status()).toBe(404);
    expect((await stranger.page.goto(paper))!.status()).toBe(404);
    expect((await stranger.page.goto(kept))!.status()).toBe(404);
    for (const sent of [start, rename, remove])
      expect((await send(stranger, sent)).status()).toBe(404);

    // The editor starts and renames, and cannot delete.
    await editor.page.goto(history);
    await expect(
      editor.page.getByRole('button', { name: 'Start a version', exact: true }),
    ).toBeVisible();
    await editor.page.getByRole('button', { name: 'More for version kept' }).click();
    await expect(editor.page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(editor.page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
    await editor.page.keyboard.press('Escape');
    expect(redirect(await send(editor, remove)), 'delete sent by hand').toContain('error=');
    expect(redirect(await send(editor, start)), 'start sent by hand').toContain('started=by-hand');
    expect(redirect(await send(editor, rename)), 'rename sent by hand').toContain(
      'renamed=renamed-by-hand',
    );
    await editor.page.goto(history);
    for (const name of ['by-hand', 'renamed-by-hand'])
      await expect(
        editor.page.locator('.history-vlist').getByRole('link', { name, exact: true }),
      ).toHaveCount(1);

    // The owner has all of it.
    await owner.page.goto(history);
    await owner.page.getByRole('button', { name: 'More for version renamed-by-hand' }).click();
    await expect(owner.page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(owner.page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  });

  test('the switcher in the editor lands on the same file, or on the paper page', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const owner = await person(browser, 'ver-editor');
    const { page } = owner;
    const paper = await newPaper(owner);
    await addFile(page, paper, 'notes.tex');
    await startNow(page, paper, 'camera-ready');
    await page.getByRole('link', { name: 'Open the version' }).click();
    await expect(page.getByRole('button', { name: 'Version: camera-ready' })).toBeVisible();
    const version = page.url().split('?')[0];
    await addFile(page, version, 'only-here.tex');

    const files = page.getByRole('navigation', { name: 'Files' });
    const editorOf = (name: string) => page.getByRole('region', { name: `Editor for ${name}` });

    // From main's notes.tex: the same file in the version, a file of its own there.
    await page.goto(paper);
    await page.getByRole('link', { name: 'notes.tex' }).first().click();
    await expect(editorOf('notes.tex')).toBeVisible();
    await expect(page.locator('main')).toHaveAttribute('data-ui', 'next');
    const mainFile = page.url().split('?')[0];
    await page.getByRole('button', { name: 'Version: main' }).click();
    await page.getByRole('menuitem', { name: 'camera-ready' }).click();
    await expect(editorOf('notes.tex')).toBeVisible();
    expect(page.url()).toMatch(new RegExp(`^${version}/files/[0-9a-f-]{36}$`));
    expect(page.url()).not.toBe(mainFile);
    await expect(page.getByRole('button', { name: 'Version: camera-ready' })).toBeVisible();

    // And back: the same file of main.
    await page.getByRole('button', { name: 'Version: camera-ready' }).click();
    await page.getByRole('menuitem', { name: /^main/ }).click();
    await expect(page).toHaveURL(mainFile);

    // A file only the version has: main's paper page.
    await page.goto(version);
    await page.getByRole('link', { name: 'only-here.tex' }).first().click();
    await expect(editorOf('only-here.tex')).toBeVisible();
    await expect(files.getByRole('link', { name: 'only-here.tex' })).toBeVisible();
    await page.getByRole('button', { name: 'Version: camera-ready' }).click();
    await page.getByRole('menuitem', { name: /^main/ }).click();
    await expect(page).toHaveURL(paper);
    await expect(page.getByRole('button', { name: 'Version: main' })).toBeVisible();
  });

  test('versions at 320 px, spaced, twice as big, and clean for axe', async ({ browser }) => {
    test.setTimeout(300_000);
    const owner = await person(browser, 'ver-narrow');
    const { page } = owner;
    const paper = await newPaper(owner);
    await startNow(page, paper, 'A version name that is long enough to need more than a line');
    await audit(page, 'the history page with a version');
    await page.getByRole('button', { name: 'Start a version', exact: true }).click();
    await audit(page, 'the dialog that starts a version');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^More for version / }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await audit(page, 'the dialog that deletes a version');
    await page.keyboard.press('Escape');
    await page.goto(paper);
    await page.getByRole('button', { name: /^Version: main/ }).click();
    await audit(page, 'the version switcher, open');
    await page.keyboard.press('Escape');

    for (const where of [paper, `${paper}/history`]) {
      await page.goto(where);
      await page.setViewportSize({ width: 320, height: 640 });
      expect(await sticksOut(page), where).toEqual([]);
      await audit(page, `${where} at 320 px`);
      await page.setViewportSize({ width: 1280, height: 720 });
      await spaced(page);
      expect(await lost(page), `${where} spaced`).toEqual([]);
      await page.reload();
      await enlarged(page);
      expect(await lost(page), `${where} twice as big`).toEqual([]);
    }
  });

  test('the switcher, open, in light and in dark: inside the page, in its colours, clean for axe', async ({
    browser,
  }) => {
    // The menu mounts in the page's overlay root, inside <main data-ui='next'>, where the look's
    // rules and colours are. Mounted on <body> instead, it has neither: no surface of its own,
    // and in dark the page's light text on white (axe: color-contrast).
    test.setTimeout(180_000);
    const owner = await person(browser, 'ver-menu-theme');
    const { page } = owner;
    const paper = await newPaper(owner);
    await startNow(page, paper, 'camera-ready');
    await page.goto(paper);
    const file = (await page.getByRole('link', { name: 'main.tex' }).first().getAttribute('href'))!;
    // --popover and --popover-foreground in app/next.css.
    const colours = {
      light: { background: 'rgb(255, 255, 255)', color: 'rgb(22, 29, 26)' },
      dark: { background: 'rgb(32, 38, 34)', color: 'rgb(232, 236, 233)' },
    };
    for (const theme of ['light', 'dark'] as const) {
      await page
        .context()
        .addCookies([
          { name: 'pw_theme', value: theme, domain: new URL(paper).hostname, path: '/' },
        ]);
      for (const [where, url] of [
        ['the paper page', paper],
        ['the editor', file],
      ]) {
        await page.goto(url);
        await page.getByRole('button', { name: /^Version: main/ }).click();
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        // Soft, so that axe below reports what the person would meet as well.
        expect
          .soft(
            await menu.evaluate((el) => ({
              inPage: !!el.closest("main[data-ui='next']"),
              background: getComputedStyle(el).backgroundColor,
              color: getComputedStyle(el).color,
            })),
            `${where}, ${theme}`,
          )
          .toEqual({ inPage: true, ...colours[theme] });
        await audit(page, `${where} with the switcher open, ${theme}`);
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
      }
    }
  });
} else {
  test('with VERSIONS off nothing of versions shows, and none can be started', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const owner = await person(browser, 'ver-off');
    const { page } = owner;
    const paper = await newPaper(owner);
    const first = await saveNamed(page, paper, 'Submitted');
    // The history page: no list, no button, no entry in a row's menu, no notice from the address.
    await page.goto(`${paper}/history?started=Ghost&version=none&renamed=Ghost&deleted=Ghost`);
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Versions' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start a version' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Version: / })).toHaveCount(0);
    await expect(said(page)).toHaveCount(0);
    await page.getByRole('button', { name: `More for revision ${first}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Give it a name' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Start a version from here' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByText(/began here/)).toHaveCount(0);
    // The paper page has no switcher either.
    await page.goto(paper);
    await expect(page.getByRole('button', { name: /^Version: / })).toHaveCount(0);
    await expect(page.getByText('All versions')).toHaveCount(0);
    await audit(page, 'the paper page with versions off');
  });
}
