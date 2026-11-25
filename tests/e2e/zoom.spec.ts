// What a person who reads with the text made bigger, or spaced wider, or in a narrow window
// still has: the same pages as the accessibility audit, and the windows for renaming and for
// inserting things. Needs the services, the sync server and the worker.
//
// Three checks, each a way to read that must not lose anything:
//  - WCAG 1.4.12, text spacing: line height 1.5, a space of 2em after a paragraph, letters
//    0.12em and words 0.16em apart, on every element (the usual text-spacing bookmarklet).
//  - WCAG 1.4.4, resize text: all the text 200% of its size, the page not zoomed.
//  - WCAG 1.4.10, reflow, at 320 CSS pixels, on the pages the narrow test in a11y.spec does not
//    visit.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { clickAfter, person, run, showSource, signIn, sticksOut } from './helpers';

const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\begin{document}',
  '\\section{Results}',
  'Latency stays below forty milliseconds, see Equation~\\ref{eq:mean} and \\cite{knuth1984}.',
  '\\begin{equation}',
  '  \\label{eq:mean}',
  '  \\bar{x} = 1',
  '\\end{equation}',
  '\\begin{table}[t]',
  '  \\caption{What was measured.}',
  '  \\begin{tabular}{ll}',
  '    A & B \\\\',
  '    1 & 2 \\\\',
  '  \\end{tabular}',
  '\\end{table}',
  'The sentense has a mistake.',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');
const BIB = '@book{knuth1984, author = {Donald Knuth}, title = {The TeXbook}, year = 1984}\n';
const WIDE_CSV =
  'day,latency (ms),median round trip time of the slowest region\n2024-03-01,9,4\n2024-03-02,38,5\n';
// One pixel, so that the figure window has a picture to offer.
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const VISUAL = '.editor .visual .ProseMirror';

/** The text-spacing bookmarklet's rules, as WCAG 1.4.12 names the values. */
const SPACING = `
  html { --text-spacing-test: 1; }
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

/**
 * Put the text-spacing rules on the page now showing, once. A new document needs them again.
 * The page's content policy refuses a <style> element that page.addStyleTag would add (as it
 * should), so the rules go in as a constructed style sheet, which the policy does not cover and
 * which applies in just the same way.
 */
async function spaced(page: Page) {
  await page.evaluate((css) => {
    if (getComputedStyle(document.documentElement).getPropertyValue('--text-spacing-test') === '1')
      return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, SPACING);
}

/**
 * Make every piece of text on the page twice as big, without zooming the page. The page's sizes
 * are mostly in pixels, which "html { font-size: 200% }" would not touch, so each element is
 * given twice its own computed size. Whatever an earlier call set is taken off first, so that a
 * call measures the page's own sizes and can be made again after the page has changed. The
 * invisible words laid over a page of the PDF are left alone: they follow the picture of the page,
 * which is not text.
 */
async function enlarged(page: Page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-was-font-size]')) {
      const was = el.dataset.wasFontSize!;
      if (was)
        el.style.setProperty(
          'font-size',
          was.replace(' !important', ''),
          was.includes('!') ? 'important' : '',
        );
      else el.style.removeProperty('font-size');
      delete el.dataset.wasFontSize;
    }
    const all = [...document.querySelectorAll<HTMLElement>('body, body *')].filter(
      (el) => el.style && !el.closest('.textLayer'),
    );
    const sizes = all.map((el) => parseFloat(getComputedStyle(el).fontSize));
    all.forEach((el, i) => {
      const own = el.style.getPropertyValue('font-size');
      el.dataset.wasFontSize = own
        ? `${own}${el.style.getPropertyPriority('font-size') ? ' !important' : ''}`
        : '';
      el.style.setProperty('font-size', `${sizes[i] * 2}px`, 'important');
    });
    window.dispatchEvent(new Event('resize'));
  });
}

/**
 * What a reader has lost on the page as it stands: the page scrolls sideways; text is cut off by
 * a box that hides what is outside it; or two things to press cover each other.
 */
const lost = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const name = (el: Element) =>
      `<${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''}>`;
    const said = (el: Element) =>
      `"${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;

    const page = document.scrollingElement!;
    if (page.scrollWidth > page.clientWidth + 1)
      out.push(`the page scrolls sideways by ${page.scrollWidth - page.clientWidth}px`);

    // Text cut off. A box whose overflow is hidden or clipped, holding text, that is smaller
    // than what it holds by more than a pixel. (A box that scrolls is fine: what is outside it
    // can be reached.) Boxes of 3px or less are the ones made for screen readers only (.sr-only,
    // the skip link before it is focused), which hold text on purpose that nobody sees.
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      const hides = (v: string) => v === 'hidden' || v === 'clip';
      if (!hides(s.overflowX) && !hides(s.overflowY)) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 3 || box.height <= 3 || s.visibility === 'hidden') continue;
      if (!(el.textContent ?? '').trim()) continue;
      const wide = hides(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const tall = hides(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (wide || tall)
        out.push(
          `${name(el)} cuts off its text (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}): ${said(el)}`,
        );
    }

    // Controls that cover each other. What each shows is its box cut down by every ancestor that
    // hides or scrolls what is outside it. A window opened with showModal, or the menu at a place,
    // is all that can be used while it is open, so only what is in it is compared.
    // A link that wraps onto a second line is two boxes, one per line (getClientRects). Its one
    // bounding box would span both lines' widths and cover the link before it on the first line,
    // though nothing on the screen overlaps.
    const scope =
      document.querySelector('dialog[open]') ?? document.querySelector('.menu') ?? document;
    const seen = [
      ...scope.querySelectorAll(
        'a[href], button, input:not([type=hidden]), select, textarea, summary',
      ),
    ].flatMap((el) => {
      // Not drawn at all: the parts of a closed <details> keep a box, but it is not painted.
      if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return [];
      const clips: DOMRect[] = [];
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden') return [];
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        clips.push(p.getBoundingClientRect());
      }
      return [...el.getClientRects()].flatMap((box) => {
        let { left, top, right, bottom } = box;
        for (const r of clips) {
          left = Math.max(left, r.left);
          top = Math.max(top, r.top);
          right = Math.min(right, r.right);
          bottom = Math.min(bottom, r.bottom);
        }
        return right - left > 3 && bottom - top > 3 ? [{ el, left, top, right, bottom }] : [];
      });
    });
    for (let i = 0; i < seen.length; i++)
      for (let j = i + 1; j < seen.length; j++) {
        const a = seen[i];
        const b = seen[j];
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (across > 1 && down > 1)
          out.push(
            `${name(a.el)} ${said(a.el)} and ${name(b.el)} ${said(b.el)} overlap by ${Math.round(across)}x${Math.round(down)}px`,
          );
      }
    return out.slice(0, 12);
  });

/**
 * Go through the pages and windows that matter, calling `look` on each as it stands. The same
 * walk for every way of reading, so that each is checked on the same things.
 */
async function tour(page: Page, email: string, look: (what: string) => Promise<void>) {
  await page.goto('/sign-in');
  await look('sign-in');
  await signIn(page, email);
  await look('papers');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Zoom ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'refs.bib', bytes: Buffer.from(BIB) },
      { path: 'data/latency.csv', bytes: Buffer.from(WIDE_CSV) },
      { path: 'img/pic.png', bytes: PICTURE },
    ]),
  );
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  const paper = page.url();
  await look('paper');
  // Every part of the page that opens, opened.
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
  await look('paper, every part opened');
  await page.reload();

  // Renaming a file: the form in its row, the page of lines it would change, and one with none.
  for (const [file, to] of [
    ['refs.bib', 'references.bib'],
    ['img/pic.png', 'img/figure.png'],
  ] as const) {
    const row = page.getByRole('row', { name: new RegExp(file.replace('.', '\\.')) });
    await row.locator('summary').click();
    await row.getByLabel(`New name for ${file}`).fill(to);
    await look(`renaming ${file}, the form`);
    await row.getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByRole('heading', { name: /^Rename .* to / })).toBeVisible();
    await look(`renaming ${file}, the page that shows what it would change`);
    await page.getByRole('link', { name: 'Back to the paper' }).click();
    await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  }
  await page.goto(`${paper}/labels/rename?from=eq:mean&to=eq:average`);
  await expect(page.getByRole('heading', { name: /Rename/ })).toBeVisible();
  await look('renaming a label, the lines it would change');
  await page.goto(paper);
  await page.getByRole('button', { name: 'Delete refs.bib' }).click();
  await expect(page.getByRole('heading', { name: 'Delete refs.bib' })).toBeVisible();
  await look('delete a file the paper reads');
  await page.goto(paper);

  await page.getByRole('link', { name: 'Describe it' }).click();
  await expect(page.getByRole('button', { name: 'Approve this description' })).toBeVisible();
  await look('data file');
  await page.getByRole('button', { name: 'Approve this description' }).click();
  await page.getByRole('link', { name: /New chart from/ }).click();
  await expect(page.getByRole('heading', { name: 'New chart' })).toBeVisible();
  await look('new chart');
  await page.getByLabel('Name', { exact: true }).fill('latency');
  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('line');
  await page.getByRole('button', { name: 'Draw the chart' }).click();
  await expect(page.getByRole('img', { name: /^Line chart of/ })).toBeVisible({ timeout: 30_000 });
  await look('a drawn chart');

  // The differences between two revisions.
  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('First');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');
  await page.getByRole('link', { name: 'refs.bib' }).first().click();
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );
  await page.locator('.editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(
    `% ${'a line long enough that it would not fit across a narrow window without scrolling, '.repeat(6)}\n`,
  );
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
  );
  await page.goto(paper);
  await page.getByLabel('Name for the paper as it is now').fill('Second');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByRole('link', { name: 'Changes since 1' }).click();
  await expect(page.getByRole('heading', { name: 'Revision 1 to revision 2' })).toBeVisible();
  await look('differences between revisions');
  await page.goto(`${paper}/submit`);
  await expect(page.getByRole('heading', { name: /before submitting/ })).toBeVisible();
  await look('checks before submitting');

  // The editor, and every window that opens over it.
  await page.goto(paper);
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator('.build').getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });
  await look('editor, visual view');
  const edit = page.getByRole('group', { name: 'Edit' });
  for (const [button, window] of [
    ['Reference', 'Insert a reference'],
    ['Citation', 'Insert a citation'],
    ['Equation', 'Insert an equation'],
    ['Footnote', 'Insert a footnote'],
    ['Figure', 'Insert a figure'],
    ['Table', 'Insert a table'],
    ['Heading', 'Insert a heading'],
  ] as const) {
    await clickAfter(page, VISUAL, 'forty');
    await edit.getByRole('button', { name: button, exact: true }).click();
    const box = page.getByRole('dialog', { name: window });
    await expect(box).toBeVisible();
    if (window === 'Insert an equation') {
      // A long formula makes the preview wider than the window, as in the narrow test.
      await box
        .getByLabel('LaTeX')
        .fill(`\\sqrt{${Array.from({ length: 40 }, (_, i) => `a_{${i}}`).join('')}}`);
      await expect(
        box.getByRole('group', { name: 'As it will look' }).locator('.katex'),
      ).toBeVisible();
    }
    if (window === 'Insert a figure')
      await expect(box.getByRole('option', { name: 'img/pic.png' })).toBeAttached();
    if (window === 'Insert a reference' || window === 'Insert a citation')
      await expect(box.getByRole('option').first()).toBeVisible();
    await look(window);
    // A refusal shows in the window, which makes it taller.
    if (window === 'Insert a table') {
      await box.getByRole('button', { name: 'Insert' }).click();
      await look(`${window}, with a field not filled in`);
    }
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
  }
  // The menu at a place, and the window for a formula already there.
  await clickAfter(page, VISUAL, 'forty');
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'At this place' });
  await expect(menu).toBeVisible();
  await look('the menu at a place');
  await page.keyboard.press('Escape');
  await page.locator(`${VISUAL} .pw-math`).first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Edit formula…' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit formula' })).toBeVisible();
  await look('Edit formula');
  await page.keyboard.press('Escape');
  await showSource(page);
  await look('editor, source view');
}

test('the checks see what they are for', async ({ page }) => {
  // A page built to lose things, so that a pass above means something.
  await page.setContent(`
    <p id="t" style="font-size: 15px">Some text</p>
    <div style="width: 60px; height: 20px; overflow: hidden">A line of text that does not fit in its box</div>
    <div style="width: 200px; height: 20px; overflow: clip">One<br>two<br>three</div>
    <div style="position: relative; height: 40px">
      <button style="position: absolute; left: 0; top: 0">First button</button>
      <button style="position: absolute; left: 20px; top: 5px">Second button</button>
    </div>
    <p style="width: 160px"><a href="#">Download ZIP</a> <a href="#" id="wraps">ZIP with review data</a></p>
    <div style="width: 3000px; height: 1px"></div>`);
  // The second link wraps, so its bounding box covers the first; on the screen they do not meet.
  expect(await page.locator('#wraps').evaluate((e) => e.getClientRects().length)).toBe(2);
  const found = await lost(page);
  expect(found.some((s) => s.startsWith('the page scrolls sideways'))).toBe(true);
  expect(found.filter((s) => s.includes('cuts off its text'))).toHaveLength(2);
  expect(found.filter((s) => s.includes('overlap'))).toHaveLength(1);
  await enlarged(page);
  expect(await page.locator('#t').evaluate((e) => getComputedStyle(e).fontSize)).toBe('30px');
  await enlarged(page); // again: still twice the original, not four times
  expect(await page.locator('#t').evaluate((e) => getComputedStyle(e).fontSize)).toBe('30px');
  await page.setContent(`<p id="t" style="font-size: 15px">Some text</p>`);
  await spaced(page);
  expect(await page.locator('#t').evaluate((e) => getComputedStyle(e).letterSpacing)).toBe('1.8px');
});

test('the pages and windows lose nothing when the text is spaced as WCAG 1.4.12 asks', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const { page, email } = await person(browser, 'zoom-spacing');
  const found: string[] = [];
  await tour(page, email, async (what) => {
    await spaced(page);
    found.push(...(await lost(page)).map((s) => `${what}: ${s}`));
  });
  expect(found).toEqual([]);
});

test('the pages and windows lose nothing when the text alone is twice as big', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const { page, email } = await person(browser, 'zoom-text');
  const found: string[] = [];
  await tour(page, email, async (what) => {
    await enlarged(page);
    found.push(...(await lost(page)).map((s) => `${what}: ${s}`));
  });
  expect(found).toEqual([]);
});

test('renaming a file and the windows for inserting things can be read in a narrow window', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const { page, email } = await person(browser, 'zoom-narrow');
  await page.setViewportSize({ width: 320, height: 800 });
  const found: string[] = [];
  await tour(page, email, async (what) => {
    found.push(...(await sticksOut(page)).map((s) => `${what}: ${s}`));
  });
  expect(found).toEqual([]);
});
