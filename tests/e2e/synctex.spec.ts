// Between the text and the PDF: a line is shown in the PDF, and a place in the PDF leads to its
// line, in this file or another. Needs Docker, the TeX image, the services and the worker.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import {
  audit,
  caretLine,
  clickAfter,
  person,
  run,
  showSource,
  showVisual,
  signIn,
  typingSaved,
} from './helpers';

// Two pages: the second section starts the second page, and is in a file of its own.
const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{First}',
  'The opening paragraph of the paper.',
  '',
  'A second paragraph, further down the first page.',
  '\\newpage',
  '\\input{second}',
  '\\end{document}',
  '',
].join('\n');
const SECOND = [
  '\\section{Second}',
  'Text on the second page.',
  '',
  'Its last paragraph.',
  '',
].join('\n');
const build = (page: Page) => page.locator('.build');

test('a line is shown in the PDF, and a place in the PDF leads back to its line', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, email } = await person(browser, 'synctex-owner');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `SyncTeX ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'second.tex', bytes: Buffer.from(SECOND) },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'second.tex' }).first().click();
  await expect(page.getByRole('region', { name: 'Editor for second.tex' })).toBeVisible();
  await expect(build(page).getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 90_000,
  });
  await expect(build(page).getByRole('group', { name: 'Page 2 of 2' })).toBeAttached();
  // The pages are not only pictures: their words are there to be read and selected.
  await expect(build(page).getByRole('group', { name: 'Page 1 of 2' })).toContainText(
    'The opening paragraph of the paper.',
  );

  // From the visual view: the caret's line is on the second page, and the pane goes there.
  await clickAfter(page, '.editor .visual .ProseMirror', 'last paragraph');
  await page
    .getByRole('group', { name: 'Go to' })
    .getByRole('button', { name: 'Show in PDF' })
    .click();
  await expect(build(page).locator('.pdf-said')).toHaveText('Shown on page 2 of the PDF.');
  const mark = build(page).locator('.pdf-mark');
  await expect(mark).toHaveAttribute('data-page', '2');
  await expect(mark).toBeInViewport();

  // From the PDF: a double-click on the first page's second paragraph leads to main.tex, line 6.
  // Find the paragraph the way a reader would: ask where line 6 is, then click there.
  const at = await page.evaluate(async () => {
    const link = document.querySelector<HTMLAnchorElement>('.build a[href$="/pdf"]')!;
    const files = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label=Files] a')];
    const main = files
      .find((a) => a.textContent === 'main.tex')!
      .href.split('/')
      .pop();
    const res = await fetch(`${link.href.replace(/pdf$/, 'sync')}?file=${main}&line=6`);
    return res.json() as Promise<{ page: number; x: number; y: number; height: number }>;
  });
  expect(at.page).toBe(1);
  /** Double-click that paragraph on the first page, wherever the page now is on the screen. */
  const pickIt = async () => {
    const shown = build(page).getByRole('group', { name: 'Page 1 of 2' });
    await build(page)
      .locator('.pdf')
      .evaluate((el) => {
        el.scrollTo(0, 0);
        el.scrollIntoView({ block: 'start' });
      });
    await expect(shown).toHaveAttribute('data-drawn', 'yes');
    const box = (await shown.boundingBox())!;
    const size = await shown.evaluate((el: HTMLElement) => ({
      w: Number(el.dataset.width),
      h: Number(el.dataset.height),
    }));
    await page.mouse.dblclick(
      box.x + ((at.x + 30) / size.w) * box.width,
      box.y + ((at.y + at.height * 0.7) / size.h) * box.height,
    );
  };
  await pickIt();
  // The other file opens, with the caret on that line.
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  await expect(page).toHaveURL(/line=6$/);
  await showSource(page);
  await expect.poll(() => caretLine(page)).toBe(6);

  // And within one file, in the source view: line 4 is on page 1.
  await clickAfter(page, '.editor .cm-content', 'opening paragraph');
  await expect.poll(() => caretLine(page)).toBe(4);
  await page.getByRole('button', { name: 'Show in PDF' }).click();
  await expect(build(page).locator('.pdf-said')).toHaveText('Shown on page 1 of the PDF.', {
    timeout: 60_000,
  });
  await expect(build(page).locator('.pdf-mark')).toHaveAttribute('data-page', '1');
  // From the PDF again, now that the line is in the file that is open: the caret goes to it,
  // and the pane says where that was.
  await pickIt();
  await expect(build(page).locator('.pdf-said')).toHaveText('That is line 6 of main.tex.');
  await expect.poll(() => caretLine(page)).toBe(6);

  // The same without a pointer. The pages are scrolled from the keyboard until the passage is
  // in the middle of the pane, and a button goes to the text for what is there. With the first
  // page at the top, the middle of the pane is below its two paragraphs: the nearer is line 6.
  await clickAfter(page, '.editor .cm-content', 'opening paragraph');
  await expect.poll(() => caretLine(page)).toBe(4);
  const pages = build(page).getByRole('region', { name: 'Pages of the PDF' });
  await pages.focus();
  await page.keyboard.press('ControlOrMeta+Home');
  await expect.poll(() => pages.evaluate((el) => el.scrollTop)).toBe(0);
  const go = build(page).getByRole('button', {
    name: 'Go to the text for the middle of the pages shown',
  });
  await go.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => caretLine(page)).toBe(6);
  // And further down, the second page, which is another file. Arrow keys scroll the pages
  // until the top of the second page's text is in the middle of the pane.
  await pages.focus();
  const wanted = await pages.evaluate((el) => {
    const second = el.querySelector<HTMLElement>('[data-page="2"]')!;
    return second.offsetTop + second.offsetHeight * 0.16 - el.clientHeight / 2;
  });
  for (let i = 0; i < 300 && (await pages.evaluate((el) => el.scrollTop)) < wanted; i++)
    await page.keyboard.press('ArrowDown');
  await go.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Editor for second.tex' })).toBeVisible();
});

test('a long PDF read to its end keeps pictures only of the pages near the window', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { page, email } = await person(browser, 'synctex-long');
  const LONG = [
    '\\documentclass{article}',
    '\\begin{document}',
    ...Array.from({ length: 30 }, (_, i) => `Page ${i + 1}.\n\\newpage`),
    '\\end{document}',
    '',
  ].join('\n');
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Long ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(LONG) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  await expect(build(page).getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 120_000,
  });
  await expect(build(page).getByRole('group', { name: 'Page 30 of 30' })).toBeAttached({
    timeout: 120_000,
  });
  const holder = (n: number) => build(page).locator(`.pdf-page[data-page="${n}"]`);
  const pictures = () =>
    build(page)
      .locator('.pdf-page canvas')
      .evaluateAll((all) => all.filter((c) => (c as HTMLCanvasElement).width > 0).length);
  // Read it through, a page at a time.
  for (let n = 1; n <= 30; n++) {
    await holder(n).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await expect(holder(n)).toHaveAttribute('data-drawn', 'yes', { timeout: 30_000 });
  }
  // The pages far behind have let go of their pictures; the one at the end has its own.
  await expect.poll(pictures).toBeLessThanOrEqual(8);
  await expect(holder(30).locator('canvas')).not.toHaveJSProperty('width', 0);
  // Back at the first: drawn again, with its words once and still readable.
  await holder(1).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(holder(1)).toHaveAttribute('data-drawn', 'yes', { timeout: 30_000 });
  await expect(holder(1).locator('canvas')).not.toHaveJSProperty('width', 0);
  await expect(holder(1).locator('.textLayer')).toHaveCount(1);
  await expect(holder(1)).toContainText('Page 1.');
});

// A two-column paper whose paragraphs wrap: each is three lines of text, with a marker word on the
// second, so that the PDF has several lines for each of them.
const paragraph = (m: string) =>
  `Para line one before the marker, with enough ordinary words to fill a column line here.\nThe word ${m} sits on the second line of this paragraph with more words after it to wrap.\nA third line closes the paragraph, nothing special about it at all, just filler text.\n`;
const WRAPPED = [
  '\\documentclass[twocolumn]{article}',
  '\\begin{document}',
  '\\section{Wrapped}',
  '',
  paragraph('MARKERA'),
  paragraph('MARKERB'),
  '\\end{document}',
  '',
].join('\n');
const lineOf = (word: string) => WRAPPED.split('\n').findIndex((l) => l.includes(word)) + 1;

async function openWrapped(browser: Parameters<typeof person>[0], who: string) {
  const { page, email } = await person(browser, who);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Wrapped ${run}.zip`);
  writeFileSync(zip, await writeZip([{ path: 'main.tex', bytes: Buffer.from(WRAPPED) }]));
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  await showSource(page);
  await expect(build(page).getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 120_000,
  });
  const holder = build(page).locator('.pdf-page[data-page="1"]');
  await holder.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(holder).toHaveAttribute('data-drawn', 'yes', { timeout: 30_000 });
  return page;
}

/**
 * Double-click the left edge of the line of the PDF a word is on, where the line's own first
 * word begins: a place that is before everything the line made.
 */
async function pickLeftEdge(page: Page, word: string) {
  const holder = build(page).locator('.pdf-page[data-page="1"]');
  const at = await holder.evaluate((el, w) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(w);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + w.length);
      const word = range.getBoundingClientRect();
      // The line the word is on: the first thing on it begins at its left edge.
      let left = Infinity;
      const all = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let m = all.nextNode(); m; m = all.nextNode()) {
        const r = document.createRange();
        r.selectNodeContents(m);
        for (const q of r.getClientRects())
          if (Math.abs(q.y + q.height / 2 - (word.y + word.height / 2)) < 2 && q.x <= word.x)
            left = Math.min(left, q.x);
      }
      const h = el.getBoundingClientRect();
      return { x: left + 1.5 - h.x, y: word.y + word.height / 2 - h.y, w: h.width, h: h.height };
    }
    return null;
  }, word);
  expect(at).not.toBeNull();
  // Bring the place to the middle of the pane and of the window, then click it.
  await holder.evaluate((el, y) => {
    const c = el.closest('.pdf') as HTMLElement;
    const h = el.getBoundingClientRect();
    c.scrollBy(0, h.y + y - (c.getBoundingClientRect().y + c.clientHeight / 2));
    const h2 = el.getBoundingClientRect();
    window.scrollBy(0, h2.y + y - window.innerHeight / 2);
  }, at!.y);
  const box = (await holder.boundingBox())!;
  await page.mouse.dblclick(
    box.x + (at!.x / at!.w) * box.width,
    box.y + (at!.y / at!.h) * box.height,
  );
}

test('a double-click at the left edge of a wrapped line of the PDF is on the line of its words', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await openWrapped(browser, 'synctex-edge');
  for (const m of ['MARKERA', 'MARKERB']) {
    await pickLeftEdge(page, m);
    await expect(build(page).locator('.pdf-said')).toHaveText(
      `That is line ${lineOf(m)} of main.tex.`,
    );
    await expect.poll(() => caretLine(page)).toBe(lineOf(m));
  }
});

test('with the PDF not rebuilt after typing above, a click goes to the line the words are on now', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await openWrapped(browser, 'synctex-behind');
  await build(page).getByLabel('Compile automatically').uncheck();
  // Ten lines on the blank line above the second paragraph: its marker is ten lines further down.
  const marker = await page.evaluate(() =>
    [...document.querySelectorAll('.editor .cm-line')].findIndex((l) =>
      l.textContent!.includes('MARKERB'),
    ),
  );
  const blank = page.locator('.editor .cm-line').nth(marker - 2);
  expect(await blank.textContent()).toBe('');
  await blank.click();
  for (let i = 1; i <= 10; i++) {
    await page.keyboard.type(`% typed ${i}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
  }
  await typingSaved(page);
  await expect(build(page).getByRole('status')).toHaveText('The PDF is behind the text.');
  await pickLeftEdge(page, 'MARKERB');
  await expect(build(page).locator('.pdf-said')).toHaveText(
    `That is line ${lineOf('MARKERB') + 10} of main.tex.`,
  );
  await expect.poll(() => caretLine(page)).toBe(lineOf('MARKERB') + 10);
});

/**
 * How page 1 of the PDF sits in its pane: the widths of the page, the pane and the picture, and
 * how much of the page's width a word of the text layer takes (the same share while the words
 * lie on the picture, whatever the width).
 */
const shape = (page: Page) =>
  build(page)
    .locator('.pdf-page[data-page="1"]')
    .evaluate((el) => {
      const pane = el.closest('.pdf') as HTMLElement;
      let share = 0;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf('MARKERA');
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + 'MARKERA'.length);
        share = range.getBoundingClientRect().width / el.clientWidth;
        break;
      }
      return {
        holderW: el.clientWidth,
        paneW: pane.clientWidth,
        paneScrollW: pane.scrollWidth,
        canvasW: el.querySelector('canvas')!.width,
        wordShare: share,
      };
    });

test('the pages of the PDF can be made larger, and stay right when the window changes', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await openWrapped(browser, 'synctex-zoom');
  const sizes = build(page).getByRole('group', { name: 'Size of the pages' });
  const state = sizes.locator('[aria-live="polite"]');
  const smaller = sizes.getByRole('button', { name: 'Smaller' });
  const larger = sizes.getByRole('button', { name: 'Larger' });
  const fit = sizes.getByRole('button', { name: 'Fit the width' });
  const base = (await shape(page)).wordShare;
  expect(base).toBeGreaterThan(0);
  await expect(state).toHaveText('Fits the width');
  await expect(smaller).toHaveAttribute('aria-disabled', 'true');
  await expect(fit).toHaveAttribute('aria-disabled', 'true');

  await larger.click();
  await expect(state).toHaveText('125%');
  await expect
    .poll(async () => {
      const s = await shape(page);
      return Math.abs(s.holderW / s.paneW - 1.25) < 0.03 && Math.abs(s.canvasW - s.holderW) <= 2;
    })
    .toBe(true);
  expect(Math.abs((await shape(page)).wordShare - base)).toBeLessThan(0.01);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );

  // Still larger: a double-click leads to the line, and "Show in PDF" comes back to it.
  await pickLeftEdge(page, 'MARKERB');
  await expect(build(page).locator('.pdf-said')).toHaveText(
    `That is line ${lineOf('MARKERB')} of main.tex.`,
  );
  await expect.poll(() => caretLine(page)).toBe(lineOf('MARKERB'));
  await page.getByRole('button', { name: 'Show in PDF' }).click();
  await expect(build(page).locator('.pdf-mark')).toBeInViewport();

  // A wider window: the picture is drawn again at the new width and the words follow it.
  await page.setViewportSize({ width: 1600, height: 720 });
  await expect
    .poll(async () => {
      const s = await shape(page);
      return Math.abs(s.canvasW - s.holderW) <= 2 && Math.abs(s.wordShare - base) < 0.01;
    })
    .toBe(true);

  await page.reload();
  await expect(build(page).locator('.pdf-page[data-page="1"]')).toHaveAttribute(
    'data-drawn',
    'yes',
    { timeout: 60_000 },
  );
  await expect(state).toHaveText('125%');

  await fit.click();
  await expect(state).toHaveText('Fits the width');
  await expect
    .poll(async () => {
      const s = await shape(page);
      return s.paneScrollW <= s.paneW + 1 && Math.abs(s.holderW - s.paneW) <= 2;
    })
    .toBe(true);
  await audit(page, 'the PDF pane with its size buttons');
});

// Words, not only lines. A two-column paper whose paragraphs are each one line of the source and
// run over many lines of the PDF, with a marker in the middle of one and at the end of another.
const filler = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence number ${from + i} is ordinary filler text.`);
const longLine = (parts: string[]) => parts.join(' ');
const WORDS_MAIN = [
  '\\documentclass[twocolumn]{article}',
  '\\begin{document}',
  '\\section{Words}',
  '',
  longLine(filler(1, 40)),
  '',
  longLine([...filler(41, 20), 'Here WORDMID stands in the middle.', ...filler(61, 20)]),
  '',
  longLine([...filler(81, 40), 'The very last word is WORDEND']) + '.',
  '',
  '\\input{second}',
  '\\end{document}',
  '',
].join('\n');
const WORDS_SECOND = [
  '\\section{Second}',
  'A closing paragraph holding SECONDWORD and more.',
  '',
].join('\n');
const WORDS_LINE = (word: string, text = WORDS_MAIN) =>
  text.split('\n').findIndex((l) => l.includes(word)) + 1;

async function openPaper(
  browser: Parameters<typeof person>[0],
  who: string,
  files: Record<string, string>,
) {
  const { page, email } = await person(browser, who);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Words ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip(Object.entries(files).map(([path, b]) => ({ path, bytes: Buffer.from(b) }))),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.getByRole('region', { name: 'Editor for main.tex' })).toBeVisible();
  await expect(build(page).getByRole('status')).toHaveText('The PDF is up to date.', {
    timeout: 120_000,
  });
  return page;
}

/**
 * Bring a word of the PDF's text into view, wherever it is, and say where it is: its page, and its
 * rectangle as shares of the page's size, and in the window.
 */
async function wordOnPage(page: Page, word: string) {
  // The pages are made once the PDF has been read: the first says how many there are.
  const first = build(page).locator('.pdf-page[data-page="1"]');
  await expect(first).toBeAttached({ timeout: 30_000 });
  const pages = Number(/of (\d+)$/.exec((await first.getAttribute('aria-label')) ?? '')?.[1]);
  for (let n = 1; n <= pages; n++) {
    const holder = build(page).locator(`.pdf-page[data-page="${n}"]`);
    await holder.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await expect(holder).toHaveAttribute('data-drawn', 'yes', { timeout: 30_000 });
    const found = await holder.evaluate((el, w) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const i = t.textContent!.indexOf(w);
        if (i < 0) continue;
        (t.parentElement as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
        const range = document.createRange();
        range.setStart(t, i);
        range.setEnd(t, i + w.length);
        const r = range.getBoundingClientRect();
        const h = el.getBoundingClientRect();
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          height: r.height,
          top: (r.top - h.top) / h.height,
          bottom: (r.bottom - h.top) / h.height,
        };
      }
      return null;
    }, word);
    if (found) return { n, ...found };
  }
  throw new Error(`${word} is not in the PDF`);
}
/** Double-click the middle of a word of the PDF's text. */
async function clickWord(page: Page, word: string) {
  const at = await wordOnPage(page, word);
  await page.mouse.dblclick(at.x, at.y);
}
/** What is selected in the editor (not what is selected in the PDF's own words). */
const selected = (page: Page) =>
  page.evaluate(() => {
    const sel = getSelection();
    const node = sel?.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    return el?.closest('.cm-content, .ProseMirror') ? sel!.toString() : '';
  });

test('a double-click on a word of the PDF selects that word, and a place in a line is shown at its word', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const page = await openPaper(browser, 'synctex-words', {
    'main.tex': WORDS_MAIN,
    'second.tex': WORDS_SECOND,
  });
  // What is asked of the server about a place never says which word it was.
  const asked: string[] = [];
  const urls: string[] = [];
  page.on('request', (r) => {
    urls.push(r.url());
    if (r.url().includes('/sync?')) asked.push(new URL(r.url()).search.slice(1));
  });
  await showSource(page);
  const mid = WORDS_LINE('WORDMID');

  // A double-click in the middle of the word selects it in the source, and says its line.
  await clickWord(page, 'WORDMID');
  await expect.poll(() => selected(page)).toBe('WORDMID');
  await expect(build(page).locator('.pdf-said')).toHaveText(`That is line ${mid} of main.tex.`);
  await expect.poll(() => caretLine(page)).toBe(mid);
  // And in the visual view.
  await showVisual(page);
  await clickWord(page, 'WORDEND');
  await expect.poll(() => selected(page)).toBe('WORDEND');
  await expect(build(page).locator('.pdf-said')).toHaveText(
    `That is line ${WORDS_LINE('WORDEND')} of main.tex.`,
  );

  // From the caret after a word: the band is on that word's line, as wide as its column.
  await showSource(page);
  await clickAfter(page, '.editor .cm-content', 'WORDEND');
  await page.getByRole('button', { name: 'Show in PDF' }).click();
  const mark = build(page).locator('.pdf-mark');
  await expect(build(page).locator('.pdf-said')).toHaveText(/^Shown on page \d+ of the PDF\.$/);
  const end = await wordOnPage(page, 'WORDEND');
  await expect(mark).toHaveAttribute('data-page', String(end.n));
  const placed = () =>
    mark.evaluate((el) => {
      const h = el.parentElement!.getBoundingClientRect();
      const m = el.getBoundingClientRect();
      const pane = el.closest('.pdf')!.getBoundingClientRect();
      return {
        top: (m.top - h.top) / h.height,
        bottom: (m.bottom - h.top) / h.height,
        width: m.width / h.width,
        inPane: m.left >= pane.left - 1 && m.right <= pane.right + 1,
      };
    });
  const line = end.bottom - end.top;
  const band = await placed();
  expect(band.top).toBeLessThan(end.bottom + line);
  expect(band.bottom).toBeGreaterThan(end.top - line);
  expect(band.width).toBeLessThan(0.6);
  await audit(page, 'the PDF pane with a place shown in its column');

  // Enlarged to 200%, the band is still in view across the pane.
  const larger = build(page).getByRole('button', { name: 'Larger' });
  for (let i = 0; i < 3; i++) await larger.click();
  await expect(build(page).getByRole('group', { name: 'Size of the pages' })).toContainText('200%');
  await page.getByRole('button', { name: 'Show in PDF' }).click();
  await expect(mark).toHaveAttribute('data-page', String(end.n));
  await expect(mark).toBeInViewport();
  await expect.poll(async () => (await placed()).inPane).toBe(true);
  await build(page).getByRole('button', { name: 'Fit the width' }).click();

  // A word of the other file opens it, and the address carries only the line.
  await clickWord(page, 'SECONDWORD');
  await expect(page.getByRole('region', { name: 'Editor for second.tex' })).toBeVisible();
  const second = WORDS_LINE('SECONDWORD', WORDS_SECOND);
  await expect(page).toHaveURL(new RegExp(`/files/[^/?]+\\?line=${second}$`));
  await expect.poll(() => selected(page)).toBe('SECONDWORD');

  // Nothing that was asked of the server, or fetched at all, names a word.
  expect(asked.length).toBeGreaterThan(3);
  for (const q of asked)
    expect(q).toMatch(
      /^(page=\d+&x=[\d.]+&y=[\d.]+(&nearest=1)?|file=[^&]+&line=\d+(&share=[\d.]+)?)$/,
    );
  expect(urls.filter((u) => /WORD|SECOND/.test(decodeURIComponent(u)))).toEqual([]);
});

// A paragraph typed in lines that do not end where the lines of the PDF do: the first word of a
// source line is where the line above ends, as far as the PDF knows.
const HARD = [
  '\\documentclass{article}',
  '\\begin{document}',
  ...[
    'First0Z of the method and system model data results approach analysis network Last0Z',
    'First1Z in a paper study show using based new problem the of with that Last1Z',
    'First2Z which from these between over into the system and method analysis Last2Z',
    'First3Z the model results data network paper study show using based new Last3Z',
    'First4Z problem in for with that this which from these between over into Last4Z',
  ],
  '',
  '\\end{document}',
  '',
].join('\n');

test('a double-click on the first word of a source line is on that line, not the one above', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await openPaper(browser, 'synctex-hard', { 'main.tex': HARD });
  await showSource(page);
  for (const n of [1, 2, 3, 4]) {
    const word = `First${n}Z`;
    await clickWord(page, word);
    await expect(build(page).locator('.pdf-said')).toHaveText(
      `That is line ${WORDS_LINE(word, HARD)} of main.tex.`,
    );
    await expect.poll(() => caretLine(page)).toBe(WORDS_LINE(word, HARD));
    await expect.poll(() => selected(page)).toBe(word);
  }
});
