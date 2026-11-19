// Formulas in the visual editor: their LaTeX is edited in place with a preview, the server makes
// the change, and the paper's own macros are drawn. Needs the services and the sync server.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { person, run, showSource, showVisual, signIn } from './helpers';

const FIXTURE = join(import.meta.dirname, '../../fixtures/ieee-multifile');
const VISUAL = '.editor .visual .ProseMirror';
const source = (page: Page) => page.locator('.editor .cm-content');
const saved = (page: Page) =>
  expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );

test('a formula is edited in place, with a preview, and without overwriting anyone', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { page, email } = await person(browser, 'math-owner');
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(FIXTURE, p), bytes: readFileSync(p) });
    }
  };
  walk(FIXTURE);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Maths ${run}.zip`);
  writeFileSync(zip, await writeZip(files));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  const paper = page.url();
  await page.getByRole('link', { name: 'sections/method.tex' }).click();
  await saved(page);
  const file = page.url();
  // A second tab on the same file, in the source view.
  const other = await page.context().newPage();
  await other.goto(file);
  await showSource(other);
  await expect(source(other)).toContainText('Let $T$ be the source text');

  const box = page.getByRole('dialog', { name: 'Edit formula' });
  const inline = page.locator(`${VISUAL} span.pw-math`).first();
  const display = page.locator(`${VISUAL} div.pw-math`).first();

  // A double click opens the formula's LaTeX. The preview follows what is typed.
  await inline.dblclick();
  await expect(box.getByLabel('LaTeX')).toHaveValue('$T$');
  await box.getByLabel('LaTeX').fill('$T_0 \\in \\RR$');
  // \\RR is the paper's own shorthand, and the paper does not define it yet.
  await expect(box).toContainText('This cannot be drawn here');
  await box.getByRole('button', { name: 'Apply' }).click();
  await expect(box).toBeHidden();
  await expect(source(other)).toContainText('Let $T_0 \\in \\RR$ be the source text');
  await expect(inline).toHaveClass(/pw-raw/);

  // Once the paper defines the macro, the formula is drawn.
  await other.getByRole('link', { name: 'macros.tex' }).click();
  // Wait for that file's editor: until it is there, the keys would go to the file being left.
  await expect(other.getByRole('region', { name: 'Editor for macros.tex' })).toBeVisible();
  await saved(other);
  await source(other).click();
  await other.keyboard.press('ControlOrMeta+End');
  await other.keyboard.type('\n\\newcommand{\\RR}{\\mathbb{R}}');
  // The page reads the paper's macros when it loads, so it shows the formula drawn once the
  // definition has been saved.
  await expect(async () => {
    await page.reload();
    // The other tab chose the source view, which this browser now opens files in.
    await showVisual(page);
    await expect(inline.locator('.katex')).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await expect(inline).not.toHaveClass(/pw-raw/);

  // A display formula, opened from the keyboard: select it, press Enter.
  await other.goto(file);
  await showSource(other);
  await display.click();
  await page.keyboard.press('Enter');
  await expect(box.getByLabel('LaTeX')).toHaveValue(/^\\begin\{align\}[\s\S]*\\end\{align\}$/);
  const align = await box.getByLabel('LaTeX').inputValue();
  await box.getByLabel('LaTeX').fill(align.replace('+ c .', '+ c + 1 .'));
  await expect(box.locator('.preview .katex')).toBeVisible();
  await box.getByRole('button', { name: 'Apply' }).click();
  await expect(box).toBeHidden();
  await expect(source(other)).toContainText('&\\le |e| + c + 1 .');
  // It was this person's edit, so they can take it back.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(source(other)).toContainText('&\\le |e| + c .');

  // Someone else changes the formula while it is open here: applying does not overwrite them.
  await display.dblclick();
  await box.getByLabel('LaTeX').fill(align.replace('+ c .', '+ 2c .'));
  await source(other).getByText('|\\sigma(e)| &\\le |e| + c .').click();
  await other.keyboard.press('End');
  await other.keyboard.type(' % theirs');
  await saved(other);
  await box.getByRole('button', { name: 'Apply' }).click();
  await expect(box.getByRole('alert')).toContainText('Someone changed this formula');
  await box.getByRole('button', { name: 'Cancel' }).click();
  await expect(box).toBeHidden();
  await expect(source(other)).toContainText('+ c . \\label{eq:minimal} % theirs');
  await expect(source(other)).not.toContainText('+ 2c .');

  // The file differs from the upload by exactly the edits that went through.
  await page.goto(paper);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  const back = await readZip(readFileSync(await download.path()));
  const text = (path: string) =>
    Buffer.from(back.entries.find((e) => e.path === path)!.bytes).toString();
  const original = files.find((f) => f.path === 'sections/method.tex')!.bytes.toString();
  expect(text('sections/method.tex')).toBe(
    original
      .replace('$T$', '$T_0 \\in \\RR$')
      .replace('\\label{eq:minimal}', '\\label{eq:minimal} % theirs'),
  );
});
