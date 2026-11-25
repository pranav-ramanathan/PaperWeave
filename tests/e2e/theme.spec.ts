// The colours of the new look (apps/web/lib/theme.ts): the control in the app bar and the cookie
// `pw_theme`, the page being drawn in the choice from its first byte, the device's own colours when
// nothing is chosen, the classic look that ignores all of it, and every page of the new look
// outside the editor in dark: axe (contrast above all), 320 px wide, spaced text, text twice as
// big. Only in a run with the new look chosen (E2E_UI=next); the editor is not here, its dark
// theme is a later task.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { audit, confirmSignIn, emailedLink, person, run, signIn, sticksOut } from './helpers';
import { enlarged, lost, spaced } from './look';

test.skip(process.env.E2E_UI !== 'next', 'the new look is chosen with E2E_UI=next');

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Results}\\label{sec:r}',
  'Latency stays below forty milliseconds~\\cite{knuth1984}, see Section~\\ref{sec:r}.',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');
const BIB = '@book{knuth1984, author = {Donald Knuth}, title = {The TeXbook}, year = 1984}\n';
const CSV = 'day,latency (ms)\n2024-03-01,9\n2024-03-02,38\n';

const DESK = 'rgb(18, 22, 20)'; // --background, dark
const LIGHT_DESK = 'rgb(238, 241, 239)'; // --background, light

/** The colour of the page's own <main>: the desk. */
const desk = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('main')!).backgroundColor);

const choose = (page: Page, theme: 'light' | 'dark' | 'system') =>
  page.context().addCookies(
    theme === 'system'
      ? []
      : [
          {
            name: 'pw_theme',
            value: theme,
            domain: new URL(page.url() === 'about:blank' ? 'http://localhost' : page.url())
              .hostname,
            path: '/',
          },
        ],
  );

test('the control: three states in a cookie, the page in them from the first byte, the device’s own when nothing is chosen, classic untouched', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { page, email } = await person(browser, 'theme-switch');
  // Nothing is chosen, whatever E2E_THEME says for the rest of the suite.
  await page.context().clearCookies({ name: 'pw_theme' });
  // The device is dark, and nothing is chosen: the page follows it. (A sign-in page is the only
  // page there is before the first sign-in, and the pages have no control: the cookie decides.)
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/sign-in');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  expect(await desk(page)).toBe(DESK);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await desk(page)).toBe(LIGHT_DESK);

  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
  const cookie = async () => (await page.context().cookies()).find((c) => c.name === 'pw_theme');
  const button = (name: RegExp) => page.getByRole('button', { name });
  const theme = page.getByRole('form', { name: 'Theme' });
  await expect(theme.getByRole('button')).toHaveCount(1);

  // Nothing chosen: no attribute, no cookie, and the control offers light.
  await expect(button(/^Colours: the device’s own\. Switch to light$/)).toBeVisible();
  expect(await cookie()).toBeUndefined();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);

  // Press: light. The device being dark changes nothing now.
  await page.emulateMedia({ colorScheme: 'dark' });
  await button(/Switch to light$/).click();
  await expect(button(/^Colours: light\. Switch to dark$/)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await desk(page)).toBe(LIGHT_DESK);
  expect(await cookie()).toMatchObject({
    value: 'light',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
  expect((await cookie())!.expires - Date.now() / 1000).toBeGreaterThan(300 * 24 * 3600);

  // Press: dark, even on a device that is light, and the server has put it in the first byte.
  await page.emulateMedia({ colorScheme: 'light' });
  await button(/Switch to dark$/).click();
  await expect(button(/^Colours: dark\. Switch to the device’s own$/)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await desk(page)).toBe(DESK);
  const first = await (await page.request.get('/projects')).text();
  expect(first).toMatch(/<html[^>]* data-theme="dark"/);
  // The control, and nothing else, is what the look test (look.spec) leaves out: one more button.
  await page.reload();
  expect(await desk(page)).toBe(DESK);

  // Press: back to the device's own, and the cookie is gone.
  await button(/Switch to the device’s own$/).click();
  await expect(button(/^Colours: the device’s own\. Switch to light$/)).toBeVisible();
  expect(await cookie()).toBeUndefined();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  expect(await desk(page)).toBe(LIGHT_DESK);

  // Dark chosen, the classic look chosen: the page is what it always was, and has no control.
  await button(/Switch to light$/).click();
  await button(/Switch to dark$/).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.context().addCookies([{ name: 'pw_ui', value: 'classic', url: page.url() }]);
  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('data-ui', 'next');
  await expect(page.getByRole('form', { name: 'Theme' })).toHaveCount(0);
  const classicColours = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    const m = getComputedStyle(document.querySelector('main')!);
    return [s.backgroundColor, s.color, m.backgroundColor, m.color, s.colorScheme];
  });
  await page.context().clearCookies({ name: 'pw_theme' });
  await page.reload();
  expect(
    await page.evaluate(() => {
      const s = getComputedStyle(document.body);
      const m = getComputedStyle(document.querySelector('main')!);
      return [s.backgroundColor, s.color, m.backgroundColor, m.color, s.colorScheme];
    }),
  ).toEqual(classicColours);
});

/** What every page of the new look must pass, in the colours it is in. */
async function checks(page: Page, what: string) {
  await expect(page.locator('main')).toHaveAttribute('data-ui', 'next');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await desk(page), `${what}: the desk is dark`).toBe(DESK);
  await audit(page, `${what} in dark`);
  const url = page.url();
  const size = page.viewportSize()!;
  // 320 px wide: nothing makes the page scroll sideways.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(url);
  expect(await sticksOut(page), `${what} at 320 px`).toEqual([]);
  await audit(page, `${what} in dark at 320 px`);
  await page.setViewportSize(size);
  // Spaced text, then text twice as big, on the page drawn afresh each time.
  await page.goto(url);
  await spaced(page);
  expect(await lost(page), `${what} with spaced text`).toEqual([]);
  await page.goto(url);
  await enlarged(page);
  expect(await lost(page), `${what} with text twice as big`).toEqual([]);
  await page.goto(url);
}

test('every page of the new look outside the editor, in dark: axe, 320 px, spaced text, text twice as big', async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const { page, email } = await person(browser, 'theme-pages');
  await page.goto('/sign-in');
  await choose(page, 'dark');
  await page.goto('/sign-in');
  await expect(page.getByLabel('Email address')).toBeVisible();
  await checks(page, 'sign-in');

  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
  await checks(page, 'papers (empty)');

  // A paper with a file, data, a bibliography and a label.
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Dark ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'refs.bib', bytes: Buffer.from(BIB) },
      { path: 'data/latency.csv', bytes: Buffer.from(CSV) },
    ]),
  );
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  const paper = page.url().split('?')[0];
  const id = /\/projects\/([^/]+)/.exec(paper)![1];
  await page.goto('/projects');
  await checks(page, 'papers');

  // Two revisions, so that there is something to compare.
  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('First draft');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');
  await page.getByLabel('Name, with folders if you like').fill('notes.tex');
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByRole('status')).toHaveText('Added notes.tex.');
  await page.getByLabel('Name for the paper as it is now').fill('With notes');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 2.');
  await page.goto(paper);
  await checks(page, 'paper');

  // The forms that stand on a page of their own.
  const fileHref = (await page
    .getByRole('link', { name: 'main.tex' })
    .first()
    .getAttribute('href'))!;
  await page.goto(`${fileHref}/rename`);
  await checks(page, 'rename a file');
  await page.goto(`${fileHref}/delete`);
  await checks(page, 'delete a file');
  await page.goto(`/projects/${id}/labels/rename?from=sec:r&to=sec:results`);
  await checks(page, 'rename a label');
  await page.goto(`/projects/${id}/owner`);
  await checks(page, 'hand the paper over');
  await page.goto(`/projects/${id}/delete`);
  await checks(page, 'delete a paper');
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
  await checks(page, 'nothing here');

  // Data, a chart from it, the checks before submitting.
  await page.goto(paper);
  const data = page.getByRole('listitem').filter({ hasText: 'data/latency.csv:' });
  await data.getByRole('link', { name: 'Describe it' }).click();
  await expect(page.getByText('2 rows, 2 columns.')).toBeVisible();
  await checks(page, 'data file');
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await expect(page.getByRole('status')).toHaveText('Description approved.');
  await page.goto(paper);
  await data.getByRole('link', { name: 'New chart from data/latency.csv' }).click();
  await expect(page.getByRole('heading', { name: 'New chart' })).toBeVisible();
  await checks(page, 'new chart');
  await page.getByLabel('Name', { exact: true }).fill('latency');
  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('line');
  await page.getByRole('combobox', { name: 'Along the bottom', exact: true }).selectOption('day');
  await page.getByRole('button', { name: 'Draw the chart' }).click();
  const picture = page.getByRole('img', { name: /^Line chart of latency/ });
  await expect(picture).toBeVisible({ timeout: 60_000 });
  // The picture stays white in dark: it is a figure for a paper, not part of the page.
  expect(await picture.evaluate((img) => getComputedStyle(img).backgroundColor)).toBe(
    'rgb(255, 255, 255)',
  );
  await checks(page, 'chart');
  await page.goto(`/projects/${id}/submit`);
  await expect(page.getByRole('heading', { name: /before submitting$/ })).toBeVisible();
  await checks(page, 'check before submitting');

  // The comparison, and the history with it.
  await page.goto(paper);
  const diff = await page.locator('a[href*="/diff/"]').first().getAttribute('href');
  await page.goto(diff!);
  await checks(page, 'comparison of two revisions');
  await page.goto(`${paper}/history`);
  await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
  await checks(page, 'history');
  await page.goto(`${paper}/history`);
  await page.getByRole('button', { name: 'Compare revision 2' }).click();
  await page.getByRole('button', { name: 'Compare revision 1' }).click();
  await page.getByRole('button', { name: 'Show the changes' }).click();
  await expect(page).toHaveURL(/history\?from=.+&to=.+#comparison/);
  await checks(page, 'history with a comparison');

  // The page the emailed link leads to, and an invitation, for someone else.
  await page.goto(paper);
  const guest = await person(browser, 'theme-guest');
  await guest.page.goto('/sign-in');
  await choose(guest.page, 'dark');
  await page.getByLabel('Their email address').fill(guest.email);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText(guest.email);
  await guest.page.goto('/sign-in');
  await guest.page.getByLabel('Email address').fill(guest.email);
  await guest.page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(guest.page.getByRole('status')).toContainText('Check');
  const link = await emailedLink(guest.email, '/sign-in/confirm');
  await guest.page.goto(link);
  await checks(guest.page, 'sign-in confirm');
  await confirmSignIn(guest.page, link);
  await guest.page.goto(await emailedLink(guest.email, '/invitations/'));
  await checks(guest.page, 'invitation');
});
