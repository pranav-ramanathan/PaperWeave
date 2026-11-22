// Live editing in the app: two people in one file, a reviewer reading along, and edits made
// while offline. Needs the services in infra/compose.yaml and the sync server.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { audit, emailedLink, person, run, showSource, showVisual, signIn } from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');

function fixtureZip() {
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  return files;
}

const status = (page: Page) =>
  page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
const source = (page: Page) => page.locator('.editor .cm-content');
/** Type at the very start of the file, as a person would. */
async function typeAtStart(page: Page, text: string) {
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type(text);
}

test('two people edit a file together, a reviewer reads along, and offline edits are kept', async ({
  browser,
}) => {
  const owner = await person(browser, 'ed-owner');
  const editor = await person(browser, 'ed-editor');
  const reviewer = await person(browser, 'ed-reviewer');
  const files = fixtureZip();
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Live ${run}.zip`);
  writeFileSync(zip, await writeZip(files));

  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  await owner.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await owner.page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(owner.page.getByRole('heading', { name: `Live ${run}` })).toBeVisible();
  for (const [who, role] of [
    [editor, 'editor'],
    [reviewer, 'reviewer'],
  ] as const) {
    await owner.page.getByLabel('Their email address').fill(who.email);
    await owner.page.getByLabel('Their role').selectOption(role);
    await owner.page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(owner.page.getByRole('status')).toContainText(who.email);
    await who.page.goto(await emailedLink(who.email, '/invitations/'));
    await signIn(who.page, who.email);
    await who.page.getByRole('button', { name: 'Join this paper' }).click();
    await expect(
      who.page.getByText(`You are ${role === 'editor' ? 'an' : 'a'} ${role}`),
    ).toBeVisible();
  }

  // Both open the same file. Each sees its text, a saved state, and the other person.
  await owner.page.getByRole('link', { name: 'sections/intro.tex' }).click();
  await showSource(owner.page);
  await expect(source(owner.page)).toContainText('\\section{Introduction}');
  await expect(status(owner.page)).toHaveText('All edits saved.');
  await editor.page.goto(owner.page.url());
  await showSource(editor.page);
  await expect(status(editor.page)).toHaveText('All edits saved.');
  await expect(owner.page.getByText(`Also here: ${editor.email}`)).toBeVisible();
  await expect(editor.page.getByText(`Also here: ${owner.email}`)).toBeVisible();

  await typeAtStart(owner.page, '% owner was here\n');
  await expect(source(editor.page)).toContainText('% owner was here');
  await typeAtStart(editor.page, '% editor too\n');
  await expect(source(owner.page)).toContainText('% editor too');
  await expect(status(owner.page)).toHaveText('All edits saved.');
  await expect(status(editor.page)).toHaveText('All edits saved.');

  // The reviewer sees the edits arrive but cannot make any.
  await reviewer.page.goto(owner.page.url());
  await showSource(reviewer.page);
  await expect(status(reviewer.page)).toHaveText('Read only. You can read along but not edit.');
  await expect(source(reviewer.page)).toContainText('% editor too');
  await source(reviewer.page).click();
  await reviewer.page.keyboard.type('REVIEWER WROTE THIS');
  await expect(source(reviewer.page)).not.toContainText('REVIEWER WROTE THIS');

  // The owner loses the connection, keeps typing, and is told the edits are waiting.
  await owner.page.context().setOffline(true);
  await expect(status(owner.page)).toContainText('Offline.');
  await typeAtStart(owner.page, '% written offline\n');
  await expect(status(owner.page)).toContainText('waiting to be saved');
  await expect(source(editor.page)).not.toContainText('% written offline');
  await owner.page.context().setOffline(false);
  await expect(status(owner.page)).toHaveText('All edits saved.', { timeout: 30_000 });
  await expect(source(editor.page)).toContainText('% written offline');

  // The download holds the edited file, and every other file exactly as uploaded.
  await owner.page.getByRole('link', { name: 'Paper overview' }).click();
  const [download] = await Promise.all([
    owner.page.waitForEvent('download'),
    owner.page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  const back = await readZip(readFileSync(await download.path()));
  const bytes = (path: string) => Buffer.from(back.entries.find((e) => e.path === path)!.bytes);
  const original = files.find((f) => f.path === 'sections/intro.tex')!.bytes.toString();
  expect(bytes('sections/intro.tex').toString()).toBe(
    '% written offline\n% editor too\n% owner was here\n' + original,
  );
  for (const f of files)
    if (f.path !== 'sections/intro.tex') expect(bytes(f.path).equals(f.bytes), f.path).toBe(true);
});

test('the source view shows invisible characters and Backspace removes one', async ({
  browser,
}) => {
  const owner = await person(browser, 'invisible-owner');
  const page = owner.page;
  const main = '\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n';
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Invisible ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]));
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(status(page)).toHaveText('All edits saved.');
  await showSource(page);
  await expect(source(page)).toContainText('Hello world.');

  await typeAtStart(page, 'Q');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('x\u200by\u202fz');
  const marks = source(page).locator('.cm-specialChar');
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(0)).toHaveAttribute('title', 'Invisible character U+200B');
  await expect(marks.nth(1)).toHaveAttribute('title', 'Invisible character U+202F');
  // The caret is after z: move back to just after the first character and delete it.
  await page.keyboard.press('ArrowLeft'); // before z
  await page.keyboard.press('ArrowLeft'); // before U+202F
  await page.keyboard.press('ArrowLeft'); // before y
  await page.keyboard.press('Backspace'); // removes U+200B
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveAttribute('title', 'Invisible character U+202F');
});

test('a file opens in the view its person last chose', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'view-owner');
  const page = owner.page;
  const view = (name: string) =>
    page.getByRole('group', { name: 'View' }).getByRole('button', { name });
  const visual = page.locator('.editor .visual .ProseMirror');
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'Latency stays below forty milliseconds.',
    '',
    '\\begin{tikzpicture}',
    '\\draw (0,0) -- (1,1);',
    '\\end{tikzpicture}',
    '',
    '\\input{body}',
    '\\end{document}',
    '',
  ].join('\n');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `View ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(main) },
      { path: 'body.tex', bytes: Buffer.from('Nothing else is claimed here.\n') },
      { path: 'refs.bib', bytes: Buffer.from('@book{k, title={A Title}}\n') },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  const paper = page.url();
  const open = async (name: string) => {
    await page.getByRole('link', { name, exact: true }).first().click();
    await page.waitForURL(/\/files\//);
    await expect(page.getByRole('region', { name: `Editor for ${name}` })).toBeVisible();
  };

  // Nothing chosen yet: the visual view.
  await open('main.tex');
  await expect(view('Visual')).toHaveAttribute('aria-pressed', 'true');
  await expect(visual).toBeVisible();

  // Source chosen, then the page reloaded: still the source.
  await showSource(page);
  await page.reload();
  await expect(view('Source')).toHaveAttribute('aria-pressed', 'true');
  await expect(source(page)).toBeVisible();
  await expect(source(page)).toContainText('Latency stays below forty');
  await audit(page, 'a file opened in the source view');

  // Another file of the paper opens in the source too.
  await page.goto(paper);
  await open('body.tex');
  await expect(view('Source')).toHaveAttribute('aria-pressed', 'true');
  await expect(source(page)).toContainText('Nothing else is claimed here.');

  // Visual chosen, then reloaded: visual. A switch the page makes itself is not remembered.
  await showVisual(page);
  await page.reload();
  await expect(view('Visual')).toHaveAttribute('aria-pressed', 'true');
  await page.goto(paper);
  await open('main.tex');
  await expect(view('Visual')).toHaveAttribute('aria-pressed', 'true');
  await visual.getByRole('button', { name: 'Edit in source' }).first().click();
  await expect(view('Source')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(view('Visual')).toHaveAttribute('aria-pressed', 'true');
  await expect(visual).toBeVisible();

  // A file with no visual view shows its source, and leaves the choice as it was.
  await page.goto(paper);
  await open('refs.bib');
  await expect(source(page)).toContainText('A Title');
  await page.goto(paper);
  await open('main.tex');
  await expect(view('Visual')).toHaveAttribute('aria-pressed', 'true');

  // The choice belongs to a browser: someone else on their own paper still starts in visual.
  await showSource(page);
  const other = await person(browser, 'view-other');
  await other.page.goto('/sign-in');
  await signIn(other.page, other.email);
  await other.page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await other.page.getByRole('button', { name: 'Import ZIP' }).click();
  await other.page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  await other.page.getByRole('link', { name: 'main.tex', exact: true }).first().click();
  await expect(
    other.page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Visual' }),
  ).toHaveAttribute('aria-pressed', 'true');
});
