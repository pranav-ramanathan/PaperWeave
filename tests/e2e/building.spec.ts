// The PDF beside the editor: it builds by itself, reports errors with their place, and keeps the
// last good PDF. Needs Docker, the TeX image, the services and the build worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { emailedLink, person, run, showSource, signIn } from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');
const build = (page: Page) => page.locator('.build');
const buildStatus = (page: Page) => build(page).getByRole('status');
const source = (page: Page) => page.locator('.editor .cm-content');

test('the PDF builds by itself, a broken edit says where, and the last good PDF stays', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'build-owner');
  const viewer = await person(browser, 'build-viewer');
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Build ${run}.zip`);
  writeFileSync(zip, await writeZip(files));

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
  await expect(build(owner.page).getByRole('img', { name: /^Page 1 of/ })).toBeVisible();
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
  await expect(build(viewer.page).getByRole('img', { name: /^Page 1 of/ })).toBeVisible();
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
