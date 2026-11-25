// Screenshots of the main pages and states, for comparing the look of the app before and after a
// change to it. Not a test of behaviour: it is not run by `pnpm e2e` or by CI (its own config,
// playwright.ui-shots.config.ts, is the only one that finds it), and it asserts nothing about the
// pictures. It does wait for what it needs to see, so that two runs on the same code give the
// same pictures.
//
//   UI_SHOTS_DIR=/some/folder ./node_modules/.bin/playwright test -c playwright.ui-shots.config.ts
//
// The same variables as for the end-to-end tests apply (services, TeX image). Each size is one
// person with a paper of their own; pictures are named d-* (1440x900) and m-* (390x844).
// What differs between two runs (the person's address, the time of day, the date) is covered by a
// flat box in the picture, in the screenshot call: the app is not changed for this.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../packages/server/src/archive';
import { person, selectWord, showSource, signIn } from './e2e/helpers';

const OUT = process.env.UI_SHOTS_DIR;
const VISUAL = '.editor .visual .ProseMirror';

const SIZES = [
  { prefix: 'd', width: 1440, height: 900 },
  { prefix: 'm', width: 390, height: 844 },
] as const;

// Fixed content, so that the pictures do not depend on the run. No \today, no random names.
const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{amsmath}',
  '\\title{Latency in shared editors}',
  '\\author{A. Writer}',
  '\\date{}',
  '\\begin{document}',
  '\\maketitle',
  '\\input{sections/intro}',
  '\\section{Results}\\label{sec:results}',
  'Latency stays below forty milliseconds for most edits~\\cite{knuth1984}.',
  '',
  'Under load the latency is high, as Section~\\ref{sec:results} shows.',
  '',
  'Measurements were taken daily.',
  '\\begin{equation}\\label{eq:sum}',
  '  \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
  '\\end{equation}',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');
const INTRO = [
  '\\section{Introduction}',
  'Editors that several people share must answer every key within a fraction of a second.',
  'We describe how that is measured, and what we found.',
  '',
].join('\n');
const BIB =
  '@book{knuth1984,\n  author = {Donald E. Knuth},\n  title = {The {\\TeX}book},\n  publisher = {Addison-Wesley},\n  year = {1984}\n}\n';
const CSV =
  'day,latency (ms),site\n2024-03-01,9,Lab\n2024-03-02,12,Lab\n2024-03-03,38,Field\n2024-03-04,41,Field\n';

/** What differs from run to run: the address, a time of day, a date. Covered in the picture. */
const varying = (page: Page, email: string): Locator[] => [
  page.getByText(email),
  page.locator('time'),
  page.getByText(/\b\d{1,2}:\d{2}\b/),
  page.getByText(/\b\d{4}-\d{2}-\d{2}\b/),
  // A revision chosen in a list is shown with its time.
  page.locator('select').filter({ hasText: /\b\d{2}:\d{2}\b/ }),
];

/**
 * While a picture is taken, every digit is as wide as every other (tabular figures), so that a
 * time, a date or a number that differs from run to run does not move what is beside it. A
 * stylesheet put on for the picture and taken off after it; the app is not changed.
 */
function steady(page: Page, on: boolean) {
  return page.evaluate((on) => {
    const w = window as unknown as { __steady?: CSSStyleSheet };
    if (on && !w.__steady) {
      w.__steady = new CSSStyleSheet();
      w.__steady.replaceSync('* { font-variant-numeric: tabular-nums !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, w.__steady];
    } else if (!on && w.__steady) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== w.__steady);
      delete w.__steady;
    }
  }, on);
}

/**
 * With UI_SHOTS_STYLES=1, the computed style of every element (and of what ::before and ::after
 * put in) is kept beside each picture, so that two runs can be compared property by property,
 * including what is off the screen. Each distinct style is written once; an element names its
 * style by number and itself by its place in the page.
 */
function computedStyles(page: Page) {
  return page.evaluate(() => {
    const styles: string[] = [];
    const known = new Map<string, number>();
    const number = (cs: CSSStyleDeclaration) => {
      let s = '';
      for (let i = 0; i < cs.length; i++) s += `${cs[i]}: ${cs.getPropertyValue(cs[i]!)}\n`;
      if (!known.has(s)) {
        known.set(s, styles.length);
        styles.push(s);
      }
      return known.get(s)!;
    };
    const place = (el: Element) => {
      const parts: string[] = [];
      for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
        const same = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0;
        parts.unshift(`${e.tagName.toLowerCase()}[${same}]`);
      }
      return parts.join('>');
    };
    const elements: Record<string, number> = {};
    for (const el of [document.documentElement, ...document.body.querySelectorAll('*')]) {
      elements[el === document.documentElement ? 'html' : place(el)] = number(getComputedStyle(el));
      for (const pseudo of ['::before', '::after'] as const) {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content !== 'none' && cs.content !== 'normal')
          elements[`${place(el)}${pseudo}`] = number(cs);
      }
      if (el instanceof HTMLDialogElement)
        elements[`${place(el)}::backdrop`] = number(getComputedStyle(el, '::backdrop'));
    }
    return { styles, elements };
  });
}

test.describe('screenshots', () => {
  test.skip(!OUT, 'UI_SHOTS_DIR names the folder the pictures go to');
  for (const size of SIZES) {
    test(`the main pages at ${size.width}x${size.height}`, async ({ browser }) => {
      test.setTimeout(420_000);
      mkdirSync(OUT!, { recursive: true });
      // An address of digits only, and of the same length in every run (see `steady`): what
      // covers it is the same size. One person per size, with a number of its own.
      const { page } = await person(browser, `shots-${size.prefix}`);
      const email = `shots-${size.prefix}-${Date.now()}@example.org`;
      await page.setViewportSize({ width: size.width, height: size.height });

      let n = 0;
      const shot = async (name: string, full = false) => {
        // The pointer out of the way, so that nothing is in its hover state in one run and not
        // in another; layout and fonts settled; nothing is changing while the picture is taken.
        await page.mouse.move(size.width - 2, 2);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        const file = `${size.prefix}-${String(++n).padStart(2, '0')}-${name}`;
        await steady(page, true);
        if (process.env.UI_SHOTS_STYLES && !full) {
          writeFileSync(
            join(OUT!, `${file}.styles.json`),
            JSON.stringify(await computedStyles(page)),
          );
        }
        await page.screenshot({
          path: join(OUT!, `${file}.png`),
          fullPage: full,
          animations: 'disabled',
          caret: 'hide',
          mask: varying(page, email),
          maskColor: '#ff00ff',
        });
        if (process.env.UI_SHOTS_TWICE && !full) {
          // The same state a second time, to tell a difference in the page from one in the
          // painting of it: a run's pictures against its own `.again.png`.
          await page.screenshot({
            path: join(OUT!, `${file}.again.png`),
            animations: 'disabled',
            caret: 'hide',
            mask: varying(page, email),
            maskColor: '#ff00ff',
          });
        }
        await steady(page, false);
      };
      // The viewport, and then the whole page where the page is longer.
      const both = async (name: string) => {
        await shot(`${name}-viewport`);
        await shot(`${name}-full`, true);
      };

      // Sign-in.
      await page.goto('/sign-in');
      await expect(page.getByLabel('Email address')).toBeVisible();
      await shot('sign-in');
      await signIn(page, email);

      // The papers list, first visit.
      await expect(page.getByRole('heading', { name: 'Your papers' })).toBeVisible();
      await shot('papers-empty');

      // One paper: two .tex files, a .bib and a CSV.
      const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-shots-')), 'Latency study.zip');
      writeFileSync(
        zip,
        await writeZip([
          { path: 'main.tex', bytes: Buffer.from(MAIN) },
          { path: 'sections/intro.tex', bytes: Buffer.from(INTRO) },
          { path: 'refs.bib', bytes: Buffer.from(BIB) },
          { path: 'data/latency.csv', bytes: Buffer.from(CSV) },
        ]),
      );
      await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
      await page.getByRole('button', { name: 'Import ZIP' }).click();
      await expect(page.getByRole('heading', { name: 'Data' })).toBeVisible();
      const paper = page.url();
      await page.goto('/projects');
      await expect(page.getByRole('link', { name: 'Latency study' })).toBeVisible();
      await both('papers-list');

      // The checks before submitting, with nothing built yet.
      await page.goto(paper);
      await page.getByRole('link', { name: 'Check before submitting' }).click();
      await expect(page.getByRole('heading', { name: /before submitting$/ })).toBeVisible();
      await both('submit-checks-not-built');

      // The data file, described and approved, and a chart drawn from it.
      await page.goto(paper);
      const data = page.getByRole('listitem').filter({ hasText: 'data/latency.csv:' });
      await data.getByRole('link', { name: 'Describe it' }).click();
      await expect(page.getByText('4 rows, 3 columns.')).toBeVisible();
      await both('data-file');
      await page.getByRole('button', { name: 'Approve this description' }).click();
      await expect(page.getByRole('status')).toHaveText('Description approved.');
      await page.goto(paper);
      await data.getByRole('link', { name: 'New chart from data/latency.csv' }).click();
      await expect(page.getByRole('heading', { name: 'New chart' })).toBeVisible();
      await page.getByLabel('Name', { exact: true }).fill('latency');
      await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('line');
      await page
        .getByRole('combobox', { name: 'Along the bottom', exact: true })
        .selectOption('day');
      await both('chart-new');
      await page.getByRole('button', { name: 'Draw the chart' }).click();
      const picture = page.getByRole('img', { name: /^Line chart of latency/ });
      await expect(picture).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(300);
      await both('chart');

      // Save the paper as it is: revision 1.
      await page.goto(paper);
      await page.getByLabel('Name for the paper as it is now').fill('First draft');
      await page.getByRole('button', { name: 'Save revision' }).click();
      await expect(page.getByRole('status')).toHaveText('Saved as revision 1.');

      // The editor: the PDF is built by opening the file.
      await page.getByRole('link', { name: 'main.tex' }).first().click();
      await expect(page.locator(VISUAL)).toContainText('forty');
      const build = page.locator('.build');
      await expect(build.getByRole('status')).toHaveText('The PDF is up to date.', {
        timeout: 120_000,
      });
      await expect(build.getByRole('group', { name: /^Page 1 of/ })).toBeVisible();
      // The page drawn on its canvas, not just its box.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const c = document.querySelector<HTMLCanvasElement>('.pdf-page canvas');
            if (!c || !c.width) return false;
            const px = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
            return !!px && px.some((v, i) => i % 4 !== 3 && v < 250);
          }),
        )
        .toBe(true);

      // A thread on one word and a proposal about another.
      const comments = page.getByRole('region', { name: 'Comments' });
      await selectWord(page, VISUAL, 'forty');
      await comments.getByRole('button', { name: 'Comment on the selected text' }).click();
      await comments.getByLabel('Comment', { exact: true }).fill('Is that the median or the tail?');
      await comments.getByRole('button', { name: 'Start thread' }).click();
      await expect(page.getByRole('article', { name: 'Thread on “forty”' })).toBeVisible();
      const proposals = page.getByRole('region', { name: 'Proposed changes' });
      await selectWord(page, VISUAL, 'high');
      await proposals.getByRole('button', { name: 'Propose a change here' }).click();
      await proposals.getByLabel('Replace it with').fill('moderate');
      await proposals.getByLabel('Why (optional)').fill('Measured again.');
      await proposals.getByRole('button', { name: 'Propose', exact: true }).click();
      await expect(page.getByRole('article', { name: 'Proposal to change “high”' })).toBeVisible();
      await expect(page.locator(`${VISUAL} .thread-mark`)).toHaveText('forty');
      await expect(page.locator(`${VISUAL} .proposal-mark`)).toHaveText('high');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.evaluate(() => scrollTo(0, 0));
      // Not the whole page (nor for the source view below): with the review lists below the
      // text, the boxes that cover the person's address are put a few pixels off in a picture
      // of the whole of the page, and the address shows under them.
      await shot('editor-visual-viewport');
      await page.getByRole('region', { name: 'Comments' }).scrollIntoViewIfNeeded();
      await shot('editor-review');

      // The insert dialogs and the menu at the caret.
      const word = await page.evaluate((sel) => {
        const walker = document.createTreeWalker(
          document.querySelector(sel)!,
          NodeFilter.SHOW_TEXT,
        );
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          const i = t.textContent!.indexOf('Measurements');
          if (i < 0) continue;
          t.parentElement!.scrollIntoView({ block: 'center' });
          const range = document.createRange();
          range.setStart(t, i);
          range.setEnd(t, i + 'Measurements'.length);
          const r = range.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, end: r.right - 1 };
        }
        return null;
      }, VISUAL);
      if (!word) throw new Error('"Measurements" is not shown');
      await page.mouse.dblclick(word.x, word.y);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Alt+=');
      const equation = page.getByRole('dialog', { name: 'Insert an equation' });
      await equation.getByLabel('LaTeX').fill('E = mc^2');
      await expect(equation.locator('.preview .katex')).toBeVisible();
      await shot('dialog-equation');
      await page.keyboard.press('Escape');
      await expect(equation).toBeHidden();

      await page.mouse.click(word.end, word.y, { button: 'right' });
      const menu = page.getByRole('menu', { name: 'At this place' });
      await expect(menu).toBeVisible();
      await shot('menu-at-caret');
      await menu.getByRole('menuitem', { name: 'Insert a table…' }).click();
      const table = page.getByRole('dialog', { name: /^Insert a table/ });
      await expect(table).toBeVisible();
      await shot('dialog-table');
      await page.keyboard.press('Escape');
      await expect(table).toBeHidden();

      // The source view, with the PDF built.
      await showSource(page);
      await expect(page.locator('.editor .cm-content')).toContainText('forty');
      // The source editor takes the keyboard a moment after it is shown, and may do so after
      // this: let go of it until it stays let go of.
      await expect(async () => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.waitForTimeout(300);
        await expect(page.locator('.editor .cm-focused')).toHaveCount(0, { timeout: 500 });
      }).toPass({ timeout: 15_000 });
      await page.evaluate(() => scrollTo(0, 0));
      await shot('editor-source-viewport');

      // A second revision, and what differs; then a third, with nothing different.
      await page.locator('.editor .cm-content').getByText('Measurements').first().waitFor();
      await selectWord(page, '.editor .cm-content', 'daily');
      await page.keyboard.type('weekly');
      const status = page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
      await expect(status).toHaveText('All edits saved.');
      await page.goto(paper);
      await page.getByLabel('Name for the paper as it is now').fill('Second draft');
      await page.getByRole('button', { name: 'Save revision' }).click();
      await expect(page.getByRole('status')).toHaveText('Saved as revision 2.');
      await both('paper');
      await page.getByRole('link', { name: 'Changes since 1' }).click();
      await expect(page.getByRole('heading', { name: 'Revision 1 to revision 2' })).toBeVisible();
      await expect(page.locator('.diff del')).toHaveText('daily');
      await both('revisions-diff');
      await page.goto(paper);
      await page.getByLabel('Name for the paper as it is now').fill('Third draft');
      await page.getByRole('button', { name: 'Save revision' }).click();
      await expect(page.getByRole('status')).toHaveText('Saved as revision 3.');
      await page.getByRole('link', { name: 'Changes since 2' }).click();
      await expect(page.getByText('Nothing differs')).toBeVisible();
      await shot('revisions-diff-nothing');

      // The checks before submitting, once the paper has been built.
      await page.goto(paper);
      await page.getByRole('link', { name: 'Check before submitting' }).click();
      await expect(page.getByRole('heading', { name: /before submitting$/ })).toBeVisible();
      await both('submit-checks');

      // The pages that ask before something is changed: rename and delete a file, rename a label,
      // hand the paper over (nobody else is on it), delete the paper.
      await page.goto(paper);
      const intro = await page
        .getByRole('link', { name: 'sections/intro.tex' })
        .first()
        .getAttribute('href');
      const fileId = intro!.split('/files/')[1]!.split(/[/?#]/)[0];
      await page.goto(`${paper}/files/${fileId}/rename?to=sections/background.tex`);
      await expect(page.getByRole('heading', { name: /^Rename / })).toBeVisible();
      await both('file-rename');
      await page.goto(`${paper}/files/${fileId}/delete`);
      await expect(page.getByRole('heading', { name: /^Delete / })).toBeVisible();
      await both('file-delete');
      await page.goto(`${paper}/labels/rename?from=sec:results&to=sec:findings`);
      await expect(page.getByRole('heading', { name: /^Rename / })).toBeVisible();
      await both('label-rename');
      await page.goto(`${paper}/owner`);
      await expect(page.getByRole('heading', { name: /^Hand / })).toBeVisible();
      await shot('owner');
      await page.goto(`${paper}/delete`);
      await expect(page.getByRole('heading', { name: /^Delete “/ })).toBeVisible();
      await shot('paper-delete');

      // Nothing here.
      await page.goto('/no-such-page');
      await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
      await shot('not-found');

      // The papers list with the paper in it, last: after the pages that changed it.
      await page.goto('/projects');
      await expect(page.getByRole('link', { name: 'Latency study' })).toBeVisible();
      await shot('papers-list-after');
    });
  }
});
