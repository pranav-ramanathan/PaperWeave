// Opening a citation, a reference, a footnote or other raw LaTeX in the visual view and editing
// its source in the formula box. Needs the services, the sync server and the worker.
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { audit, clickAfter, person, run, showSource, signIn, sourceText } from './helpers';

const VISUAL = '.editor .visual .ProseMirror';
const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Intro}\\label{sec:x}',
  'Words \\citep{a} here, and \\ref{sec:x} again.\\footnote{Old note.} Done.',
  '\\end{document}',
  '',
].join('\n');

test('a citation, a reference and a footnote are opened and edited as LaTeX', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { page, email } = await person(browser, 'atoms');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `atoms ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  const project = page.url();
  await expect(page.locator('.report:not(.first-steps) li').first()).toHaveText(
    'Imported 1 file: root main.tex, compiler pdflatex, 51% of body prose editable visually, 0 source-only files.',
  );
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator(`${VISUAL}[contenteditable=true]`)).toBeVisible();

  // A double click on a citation opens its LaTeX.
  await page.locator(`${VISUAL} .pw-cite`).dblclick();
  const cite = page.getByRole('dialog', { name: 'Edit citation' });
  await expect(cite.getByLabel('LaTeX')).toHaveValue('\\citep{a}');
  await audit(page, 'the box for a citation');
  await cite.getByLabel('LaTeX').fill('\\citep[p.~3]{a,b}');
  await cite.getByRole('button', { name: 'Apply' }).click();
  await expect(cite).toBeHidden();
  await expect(page.locator(`${VISUAL} .pw-cite`)).toHaveText('[a, b]');

  // A reference selected with the arrow keys opens with Enter.
  await clickAfter(page, VISUAL, 'Words');
  const ref = page.locator(`${VISUAL} .ProseMirror-selectednode.pw-ref`);
  for (let i = 0; i < 40 && !(await ref.count()); i++) await page.keyboard.press('ArrowRight');
  await expect(ref).toHaveCount(1);
  await page.keyboard.press('Enter');
  const reference = page.getByRole('dialog', { name: 'Edit reference' });
  await expect(reference.getByLabel('LaTeX')).toHaveValue('\\ref{sec:x}');
  await page.keyboard.press('Escape');
  await expect(reference).toBeHidden();

  // A footnote reads as its words, not as LaTeX, and says what it is to a screen reader.
  const chip = page.locator(`${VISUAL} .pw-raw_inline`);
  await expect(chip).toHaveText('Footnote: Old note.');
  await expect(chip).toHaveAttribute('aria-label', 'footnote: Old note.');
  await expect(chip).toHaveAttribute('title', '\\footnote{Old note.}');

  // The menu on a footnote offers to edit it, and an edit that would change its surroundings
  // is refused with the box kept open.
  await page.locator(`${VISUAL} .pw-raw_inline`).click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem').first()).toHaveText('Edit footnote…');
  await menu.getByRole('menuitem', { name: 'Edit footnote…' }).click();
  const note = page.getByRole('dialog', { name: 'Edit footnote' });
  await expect(note.getByLabel('LaTeX')).toHaveValue('\\footnote{Old note.}');
  await note.getByLabel('LaTeX').fill('\\footnote{unclosed');
  await note.getByRole('button', { name: 'Apply' }).click();
  await expect(note.getByRole('alert')).toContainText('change how the text around it is read');
  await expect(note).toBeVisible();
  await note.getByLabel('LaTeX').fill('\\footnote{New \\emph{note}.}');
  await note.getByRole('button', { name: 'Apply' }).click();
  await expect(note).toBeHidden();
  await expect(chip).toHaveText('Footnote: New note.');
  await expect(page.locator(`${VISUAL} .pw-frozen`)).toHaveCount(0);

  await showSource(page);
  const want = MAIN.replace('\\citep{a}', '\\citep[p.~3]{a,b}').replace(
    '\\footnote{Old note.}',
    '\\footnote{New \\emph{note}.}',
  );
  await expect.poll(() => sourceText(page)).toContain('\\citep[p.~3]{a,b} here');
  expect(await sourceText(page)).toContain('\\footnote{New \\emph{note}.} Done.');
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );
  await page.goto(project);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  const back = await readZip(readFileSync(await download.path()));
  expect(Buffer.from(back.entries.find((e) => e.path === 'main.tex')!.bytes).toString()).toBe(want);
});
