// Revisions in the app: save, build, download, compare, restore, rename.
// Needs Docker, the TeX image, the services, the sync server and the build worker.
import { execFileSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { readZip } from '../../packages/server/src/archive';
import {
  audit,
  emailedLink,
  person,
  run,
  selectWord,
  showSource,
  signIn,
  typingSaved,
} from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/article-basic');
const source = (page: Page) => page.locator('.editor .cm-content');
const editorStatus = (page: Page) =>
  page.getByRole('region', { name: /^Editor for/ }).getByRole('status');

test('save a revision, build and download it, compare, restore and rename', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'rev-owner');
  const page = owner.page;
  const files: { path: string; bytes: Buffer }[] = [];
  for (const f of readdirSync(FIXTURE))
    if (statSync(join(FIXTURE, f)).isFile())
      files.push({
        path: relative(FIXTURE, join(FIXTURE, f)),
        bytes: readFileSync(join(FIXTURE, f)),
      });
  const dir = mkdtempSync(join(tmpdir(), 'paperweave-e2e-'));
  writeFileSync(join(dir, `Revs ${run}.zip`), await writeZip(files));

  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page
    .getByLabel('Or import a ZIP of a LaTeX project')
    .setInputFiles(join(dir, `Revs ${run}.zip`));
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();

  // Save the paper as it is, and build that exact revision.
  await page.getByLabel('Name for the paper as it is now').fill('As uploaded');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');
  await page.getByRole('button', { name: 'Build PDF for revision 1' }).click();
  const first = page.getByRole('row', { name: /1\. As uploaded/ });
  await expect(async () => {
    await page.goto(paper);
    await expect(first.getByRole('link', { name: 'PDF' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  const pdf = await page.request.get(
    (await first.getByRole('link', { name: 'PDF' }).getAttribute('href'))!,
  );
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  // Its ZIP holds the uploaded bytes and says how to rebuild it.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    first.getByRole('link', { name: 'ZIP with build details' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`Revs ${run} r1.zip`);
  const zipPath = await download.path();
  const read = (name: string) => execFileSync('unzip', ['-p', zipPath, name]);
  expect(read('main.tex').equals(files.find((f) => f.path === 'main.tex')!.bytes)).toBe(true);
  expect(JSON.parse(read('paperweave-toolchain.json').toString())).toMatchObject({
    revision: 1,
    root: 'main.tex',
    compiler: 'pdflatex',
  });

  // Edit, save again, and see exactly what changed.
  await page.getByRole('link', { name: 'main.tex' }).click();
  await showSource(page);
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('% a regrettable first line\n');
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('With a regret');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByRole('link', { name: 'Changes since 1' }).click();
  await expect(page.getByRole('heading', { name: 'Revision 1 to revision 2' })).toBeVisible();
  await audit(page, 'the differences between two revisions');
  await expect(page.locator('.diff .added')).toHaveText('+ % a regrettable first line\n');
  await expect(page.locator('.diff .removed')).toHaveCount(0);

  // Restore the first revision: the editor shows the original text again.
  await page.goto(paper);
  await page.getByRole('button', { name: 'Restore revision 1' }).click();
  await expect(page.getByRole('status')).toHaveText('Restored. The paper is now revision 3.');
  await expect(page.getByRole('row', { name: /3\. Restore of revision 1/ })).toBeVisible();
  await page.getByRole('link', { name: 'main.tex' }).click();
  await showSource(page);
  await expect(source(page)).toContainText('Synthetic fixture');
  await expect(source(page)).not.toContainText('regrettable');

  // Rename a file: the new name shows, a bad one is refused with a reason.
  await page.goto(paper);
  const bib = page.getByRole('row', { name: /refs\.bib/ });
  await bib.locator('summary').click();
  await bib.getByLabel('New name for refs.bib').fill('../outside.bib');
  await bib.getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('main [role=alert]')).toContainText('That name cannot be used');
  const again = page.getByRole('row', { name: /refs\.bib/ });
  await again.locator('summary').click();
  await again.getByLabel('New name for refs.bib').fill('bibliography/refs.bib');
  await again.getByRole('button', { name: 'Rename' }).click();
  // The root file names this one, so the line that would change is shown before anything does.
  await expect(page.getByText('1 line names this file.')).toBeVisible();
  const change = page.getByRole('region', { name: 'main.tex' });
  await expect(change).toContainText('\\bibliography{refs}');
  await expect(change).toContainText('\\bibliography{bibliography/refs}');
  await audit(page, 'the lines a file rename would change');
  await page.getByRole('button', { name: 'Rename and update that line' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Renamed to bibliography/refs.bib, and updated 1 place that names it.',
  );
  await expect(page.getByRole('row', { name: /bibliography\/refs\.bib/ })).toBeVisible();
  // The paper still builds: the line that named the file names it still.
  await page.getByRole('link', { name: 'main.tex' }).click();
  await showSource(page);
  await expect(source(page)).toContainText('\\bibliography{bibliography/refs}');
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 60_000,
  });
});

test("a second person's typing in an untouched paragraph survives a restore in order", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const paras = [
    'P1 alpha foxes jump over fences.',
    'P2 beta cats sleep all day.',
    'P3 gamma wolves howl loudly at night.',
    'P4 delta owls watch the dark.',
    'P5 epsilon bears wait for spring.',
  ];
  const main = `\\documentclass{article}\n\\begin{document}\n${paras.join('\n\n')}\n\\end{document}\n`;
  const owner = await person(browser, 'typ-owner');
  const editor = await person(browser, 'typ-editor');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Typing ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = owner.page.url();
  await owner.page.getByLabel('Their email address').fill(editor.email);
  await owner.page.getByLabel('Their role').selectOption('editor');
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('status')).toContainText(editor.email);
  await editor.page.goto(await emailedLink(editor.email, '/invitations/'));
  await signIn(editor.page, editor.email);
  await editor.page.getByRole('button', { name: 'Join this paper' }).click();
  await expect(editor.page.getByText('You are an editor')).toBeVisible();

  // Revision 1 is the paper as it is; then the owner changes the first and last paragraphs.
  await owner.page.getByLabel('Name for the paper as it is now').fill('A');
  await owner.page.getByRole('button', { name: 'Save revision' }).click();
  await expect(owner.page.getByRole('status')).toHaveText('Saved as revision 1.');
  await owner.page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(owner.page);
  await selectWord(owner.page, '.editor .cm-content', 'jump');
  await owner.page.keyboard.type('sprint');
  await selectWord(owner.page, '.editor .cm-content', 'wait');
  await owner.page.keyboard.type('hibernate');
  await typingSaved(owner.page);
  const file = owner.page.url();

  await editor.page.goto(file);
  await showSource(editor.page);
  await expect(source(editor.page)).toContainText('bears hibernate', { timeout: 15_000 });
  await editor.page.locator('.cm-line', { hasText: 'P3 gamma wolves' }).click();
  await editor.page.keyboard.press('Home');
  for (let i = 0; i < 16; i++) await editor.page.keyboard.press('ArrowRight');

  // They type while the owner restores revision 1.
  const paperPage = await owner.page.context().newPage();
  await paperPage.goto(paper);
  const typing = editor.page.keyboard.type('abcdefgh', { delay: 150 });
  await editor.page.waitForTimeout(430);
  await paperPage.getByRole('button', { name: 'Restore revision 1' }).click();
  await expect(paperPage.getByRole('status').first()).toContainText('Restored. The paper is now');
  await typing;
  await expect(source(editor.page)).toContainText('foxes jump', { timeout: 15_000 });
  await typingSaved(editor.page);

  // Letters typed before the restore were part of the paper it replaced, and go with it. The rest
  // are where they were typed, in order, inside that paragraph, and nothing else differs.
  await paperPage.goto(paper);
  const [download] = await Promise.all([
    paperPage.waitForEvent('download'),
    paperPage.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  const saved = Buffer.from(
    (await readZip(readFileSync(await download.path()))).entries.find((e) => e.path === 'main.tex')!
      .bytes,
  ).toString();
  const kept = /^P3 gamma wolves ([a-h]*)howl loudly/m.exec(saved)?.[1];
  expect(kept, 'the letters in P3').toBeDefined();
  expect('abcdefgh'.endsWith(kept!)).toBe(true);
  expect(saved).toBe(main.replace('P3 gamma wolves ', `P3 gamma wolves ${kept}`));
});

test('a comparison shows only what changed, and which words', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await person(browser, 'diff-owner');
  const page = owner.page;
  const long = `${'The delay stays low in every run we made. '.repeat(14)}After forty runs it was the same. ${'Nothing else moved at all. '.repeat(10)}`;
  const body = Array.from({ length: 56 }, (_, i) => (i === 2 ? long : `Line number ${i + 3}.`));
  const main = `\\documentclass{article}\n\\begin{document}\n${body.join('\n')}\n\\end{document}\n`;
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Words ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  await page.getByLabel('Name for the paper as it is now').fill('Forty');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');

  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(page);
  await selectWord(page, '.editor .cm-content', 'forty');
  await page.keyboard.type('thirty');
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('Thirty');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByRole('link', { name: 'Changes since 1' }).click();
  await expect(page.getByRole('heading', { name: 'Revision 1 to revision 2' })).toBeVisible();

  // Line 5 and three lines each side; the rest is counted, not shown.
  await expect(page.locator('.diff .kept')).toHaveCount(6);
  await expect(page.locator('.diff del')).toHaveText('forty');
  await expect(page.locator('.diff ins')).toHaveText('thirty');
  await expect(page.locator('.diff .gap').last()).toContainText('unchanged lines after this');
  await expect(page.locator('.diff .gap').first()).toBeVisible();
  await expect(page.locator('.diff .gap').first()).toHaveText('1 unchanged line, then line 2:\n');
  // A long line wraps instead of scrolling sideways, and the changed word can be seen.
  expect(await page.locator('.diff').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await expect(page.locator('.diff ins')).toBeInViewport();
  await audit(page, 'a comparison with words marked');
});

test('a comparison still marks the changed word when a paragraph was added after it', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await person(browser, 'diff-added');
  const page = owner.page;
  const long = `${'The delay stays low in every run we made. '.repeat(14)}After forty runs it was the same. ${'Nothing else moved at all. '.repeat(10)}`;
  const body = Array.from({ length: 10 }, (_, i) => (i === 2 ? long : `Line number ${i + 3}.`));
  const main = `\\documentclass{article}\n\\begin{document}\n${body.join('\n')}\n\\end{document}\n`;
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Added ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  await page.getByLabel('Name for the paper as it is now').fill('Forty');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');

  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await showSource(page);
  await selectWord(page, '.editor .cm-content', 'forty');
  await page.keyboard.type('thirty');
  // End stops at each wrapped row of the long line first, then at the end of the paragraph.
  for (let k = 0; k < 40; k++) await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A new paragraph follows.');
  await expect(editorStatus(page)).toHaveText('All edits saved.');
  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('Thirty');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByRole('link', { name: 'Changes since 1' }).click();
  await expect(page.getByRole('heading', { name: 'Revision 1 to revision 2' })).toBeVisible();

  await expect(page.locator('.diff del')).toHaveText('forty');
  await expect(page.locator('.diff ins')).toHaveText('thirty');
  await expect(
    page.locator('.diff .added:not(.part)').filter({ hasText: 'A new paragraph follows.' }),
  ).toHaveCount(1);
  expect(await page.locator('.diff').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await audit(page, 'a comparison with a paragraph added after a marked line');
});
