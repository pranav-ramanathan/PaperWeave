// The PDF beside the editor: it builds by itself, reports errors with their place, and keeps the
// last good PDF. Needs Docker, the TeX image, the services and the build worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { emailedLink, person, run, showSource, signIn, typingSaved } from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');
const build = (page: Page) => page.locator('.build');
const buildStatus = (page: Page) => build(page).getByRole('status');
const source = (page: Page) => page.locator('.editor .cm-content');

/** A ZIP of the fixture, named for this run. */
async function fixtureZip(name: string, under = '') {
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: under + relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  // A different paper at the top, so the folder's is not the root until it is made one.
  if (under)
    files.push({
      path: 'main.tex',
      bytes: Buffer.from('\\documentclass{article}\\begin{document}Top.\\end{document}\n'),
    });
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `${name} ${run}.zip`);
  writeFileSync(zip, await writeZip(files));
  return zip;
}

test('the PDF builds by itself, a broken edit says where, and the last good PDF stays', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'build-owner');
  const viewer = await person(browser, 'build-viewer');
  const zip = await fixtureZip('Build');

  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByLabel('Their email address').fill(viewer.email);
  await owner.page.getByLabel('Their role').selectOption('viewer');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(viewer.email);

  // Opening a file is enough: the paper compiles without being asked.
  await owner.page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await showSource(owner.page);
  await expect(buildStatus(owner.page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });
  const frame = build(owner.page).getByRole('link', { name: 'Open the PDF by itself' });
  const first = (await frame.getAttribute('href'))!;
  // The pages themselves are drawn in the pane.
  await expect(build(owner.page).getByRole('group', { name: /^Page 1 of/ })).toBeVisible();
  const pdf = await owner.page.request.get(first);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  // A broken edit: the error names the file and line, and the last good PDF is still shown.
  await source(owner.page).click();
  await owner.page.keyboard.press('ControlOrMeta+End');
  await owner.page.keyboard.type('\\nosuchmacro');
  await expect(buildStatus(owner.page)).toHaveText('The latest build failed.', { timeout: 60_000 });
  await expect(build(owner.page).getByRole('list', { name: 'Build errors' })).toContainText(
    /sections\/intro\.tex:\d+ Undefined control sequence\./,
  );
  await expect(build(owner.page)).toContainText('before the latest edits');
  expect(await frame.getAttribute('href')).toBe(first);
  const log = await owner.page.request.get(
    (await build(owner.page).getByRole('link', { name: 'Build log' }).getAttribute('href'))!,
  );
  expect(await log.text()).toContain('Undefined control sequence');

  // Repairing it brings a new PDF.
  for (let i = 0; i < '\\nosuchmacro'.length; i++) await owner.page.keyboard.press('Backspace');
  await owner.page.keyboard.type('% fixed');
  await expect(buildStatus(owner.page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });
  expect(await frame.getAttribute('href')).not.toBe(first);

  // A viewer sees the PDF but cannot start a build, by button or by request.
  await viewer.page.goto(await emailedLink(viewer.email, '/invitations/'));
  await signIn(viewer.page, viewer.email);
  await viewer.page.getByRole('button', { name: 'Join this paper' }).click();
  await viewer.page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await expect(buildStatus(viewer.page)).toHaveText('The PDF is up to date.');
  await expect(build(viewer.page).getByRole('group', { name: /^Page 1 of/ })).toBeVisible();
  await expect(build(viewer.page).getByRole('button', { name: 'Compile now' })).toHaveCount(0);
  const paper = viewer.page.url().split('/files/')[0];
  expect(
    (
      await viewer.page.request.post(`${paper}/builds`, {
        headers: { origin: 'http://localhost:3100' },
      })
    ).status(),
  ).toBe(403);
  // And a request from another site is refused outright.
  expect(
    (
      await owner.page.request.post(`${paper}/builds`, {
        headers: { origin: 'https://evil.example' },
      })
    ).status(),
  ).toBe(403);
});

test('a citation to nothing is listed on a build that worked, and a broken .bib says where', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'build-warn');
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page
    .getByLabel('Or import a ZIP of a LaTeX project')
    .setInputFiles(await fixtureZip('Warn'));
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await showSource(owner.page);
  await expect(buildStatus(owner.page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });
  const warnings = build(owner.page).getByRole('list', { name: 'Build warnings' });
  await expect(warnings).toHaveCount(0);

  // A citation to nothing builds, and the pane says what will show as ?? in the PDF.
  await source(owner.page).click();
  await owner.page.keyboard.press('ControlOrMeta+End');
  await owner.page.keyboard.type('\\cite{nokey}');
  await expect(warnings).toContainText(
    /sections\/intro\.tex:\d+ Citation `nokey' on page \d+ undefined/,
    {
      timeout: 60_000,
    },
  );
  await expect(buildStatus(owner.page)).toHaveText('The PDF is up to date.');
  await expect(build(owner.page)).toContainText('Built, but the PDF shows ?? for:');

  // A broken .bib: the build fails, and the error is in refs.bib at a line.
  await owner.page.getByRole('link', { name: 'refs.bib' }).click();
  await expect(owner.page.getByRole('region', { name: 'Editor for refs.bib' })).toBeVisible();
  await expect(source(owner.page)).toContainText('Knuth},');
  await source(owner.page).click();
  await owner.page.keyboard.press('ControlOrMeta+Home');
  await owner.page.keyboard.press('ArrowDown');
  await owner.page.keyboard.press('End');
  await owner.page.keyboard.press('Backspace');
  await expect(source(owner.page)).not.toContainText('Knuth},');
  await expect(buildStatus(owner.page)).toHaveText('The latest build failed.', { timeout: 60_000 });
  await expect(build(owner.page).getByRole('list', { name: 'Build errors' })).toContainText(
    /refs\.bib:\d+ BibTeX: /,
  );

  // Repairing both clears the lists.
  await owner.page.keyboard.type(',');
  await expect(buildStatus(owner.page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });
  await expect(build(owner.page).getByRole('list', { name: 'Build errors' })).toHaveCount(0);
  await owner.page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await expect(
    owner.page.getByRole('region', { name: 'Editor for sections/intro.tex' }),
  ).toBeVisible();
  // The editor takes no typing until the file has arrived: wait for its text first.
  await expect(source(owner.page)).toContainText('\\cite{nokey}');
  await source(owner.page).click();
  await owner.page.keyboard.press('ControlOrMeta+End');
  for (let i = 0; i < '\\cite{nokey}'.length; i++) await owner.page.keyboard.press('Backspace');
  await expect(source(owner.page)).not.toContainText('nokey');
  await expect(warnings).toHaveCount(0, { timeout: 60_000 });
});

test('the PDF is behind only when the paper has changed, and is built once for each change', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { page, email } = await person(browser, 'build-second');
  await page.goto('/sign-in');
  await signIn(page, email);
  await page
    .getByLabel('Or import a ZIP of a LaTeX project')
    .setInputFiles(await fixtureZip('Second'));
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });

  // Opening a file writes the first entry of its log. That is not an edit: the PDF is still of
  // this text, and the pane, which builds whenever the PDF is behind, has nothing to ask for.
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/builds')) asked.push(r.url());
  });
  await page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.');
  // Long enough for the pane to have looked several times.
  await page.waitForTimeout(9000);
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.');
  expect(asked).toEqual([]);

  // Typed and taken back: the log has moved and the text has not. One build puts it right.
  await showSource(page);
  await source(page).click();
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.', { timeout: 30_000 });
  await page.waitForTimeout(9000);
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.');
  expect(asked.length).toBeLessThanOrEqual(2);

  // Someone builds the PDF of an older revision, one saved between two builds. That is now the
  // newest build, and it is not of the paper as it stands: the pane builds the paper again.
  const other = await page.context().newPage();
  const paper = page.url().split('/files/')[0];
  const auto = build(page).getByRole('checkbox', { name: 'Compile automatically' });
  await auto.uncheck();
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('% one');
  await typingSaved(page);
  await other.goto(paper);
  await other.getByLabel('Name for the paper as it is now').fill('One');
  await other.getByRole('button', { name: 'Save revision' }).click();
  await expect(other.getByRole('status')).toContainText('Saved as revision');
  await page.keyboard.type(' two');
  await typingSaved(page);
  await auto.check();
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.', { timeout: 30_000 });
  const before = asked.length;
  await other.reload();
  await other.getByRole('button', { name: /^Build the PDF for revision/ }).click();
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.', { timeout: 30_000 });
  await expect(build(page)).not.toContainText('before the latest edits');

  // The paper changes with nothing typed: in another window, a file it reads is deleted. The
  // PDF is no longer of this paper, and the pane finds that out and builds by itself.
  await other.goto(paper);
  await other.getByRole('button', { name: 'Delete tables/ablation.tex' }).click();
  await expect(other.getByRole('status')).toContainText('Deleted tables/ablation.tex.');
  await expect(buildStatus(page)).toHaveText('The latest build failed.', { timeout: 30_000 });
  await expect(build(page)).toContainText('before the latest edits');
});

test('an editor nobody is looking at asks the server for nothing', async ({ browser }) => {
  const { page, email } = await person(browser, 'build-hidden');
  await page.goto('/sign-in');
  await signIn(page, email);
  await page
    .getByLabel('Or import a ZIP of a LaTeX project')
    .setInputFiles(await fixtureZip('Hidden'));
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });

  // What the page asks for by itself: how the builds stand, and the threads and proposals.
  const asked: string[] = [];
  page.on('request', (r) => {
    const what = /\/(builds|threads|proposals)(\?|$)/.exec(r.url())?.[1];
    if (what && r.method() === 'GET') asked.push(what);
  });
  await page.waitForTimeout(5500);
  expect(new Set(asked)).toEqual(new Set(['builds', 'threads', 'proposals']));

  // The tab goes behind another. (The browser says so to the page; here the page is told the
  // same thing directly.)
  const show = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await show(true);
  await page.waitForTimeout(500);
  asked.length = 0;
  await page.waitForTimeout(6000);
  expect(asked).toEqual([]);

  // Looked at again: it catches up at once, not at the next turn of a clock.
  await show(false);
  await expect.poll(() => new Set(asked).size, { timeout: 1500 }).toBe(3);
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.');
});

test('a build that is not being built says so, and does not say "compiling" for ever', async ({
  browser,
}) => {
  const { page, email } = await person(browser, 'build-stuck');
  await page.goto('/sign-in');
  await signIn(page, email);
  await page
    .getByLabel('Or import a ZIP of a LaTeX project')
    .setInputFiles(await fixtureZip('Stuck'));
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });

  // The server's answer as it would be with the build worker stopped: the newest build has
  // been waiting, first for a few seconds and then for five minutes.
  let since = 5_000;
  await page.route(/\/projects\/[0-9a-f-]+\/builds$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 200, json: {} });
    const real = await (await route.fetch()).json();
    const waiting = {
      ...real.latest,
      id: '00000000-0000-4000-8000-000000000000',
      status: 'queued',
      createdAt: new Date(Date.now() - since).toISOString(),
      finishedAt: null,
      hasPdf: false,
    };
    await route.fulfill({ json: { ...real, latest: waiting } });
  });
  await expect(buildStatus(page)).toHaveText('Compiling…');
  since = 5 * 60_000;
  await expect(buildStatus(page)).toHaveText(
    'Still waiting to compile after two minutes. The build service may be busy or not running.',
  );
  // The last PDF that was built is still shown meanwhile.
  await expect(build(page).getByRole('group', { name: /^Page 1 of/ })).toBeVisible();
});

test('a paper whose root file is in a folder builds', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, email } = await person(browser, 'folder-root');
  await page.goto('/sign-in');
  await signIn(page, email);
  await page
    .getByLabel('Or import a ZIP of a LaTeX project')
    .setInputFiles(await fixtureZip('Folder', 'paper/'));
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  // The paper's own \input{sections/intro} and \bibliography{refs} are read from paper/.
  await page.getByRole('button', { name: 'Make paper/main.tex the root file' }).click();
  await expect(page.getByRole('row', { name: /paper\/main\.tex/ })).toContainText('Root file');
  await page.getByRole('link', { name: 'paper/sections/intro.tex' }).click();
  await expect(buildStatus(page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });
  await expect(build(page).getByRole('group', { name: /^Page 1 of/ })).toBeVisible();
});

test('a \\hyperref to nothing is listed on a build that worked', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'build-hyper');
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Hyper ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      {
        path: 'main.tex',
        bytes: Buffer.from(
          '\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\nSee \\hyperref[nolabel]{there}.\n\\end{document}\n',
        ),
      },
    ]),
  );
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await owner.page.getByRole('link', { name: 'main.tex', exact: true }).click();
  await showSource(owner.page);
  await expect(buildStatus(owner.page)).toHaveText('The PDF is up to date.', { timeout: 60_000 });
  await expect(build(owner.page).getByRole('list', { name: 'Build warnings' })).toContainText(
    /main\.tex:\d+ Hyper reference `nolabel' on page \d+ undefined/,
  );
});
