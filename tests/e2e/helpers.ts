// Shared by the browser tests that need a signed-in person.
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

export const MAIL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const run = Date.now().toString(36);
export const address = (who: string) => `${who}-${run}@example.org`;

/** The first link in the newest email sent to an address. */
export async function emailedLink(to: string, containing: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const found = await (
      await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
    ).json();
    for (const m of found.messages ?? []) {
      const { Text } = await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json();
      const link = /https?:\/\/\S+/.exec(Text as string)?.[0];
      if (link?.includes(containing)) return link;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email with a ${containing} link reached ${to}`);
}

/** Ask for a sign-in link on the page that is showing the form, then follow it. */
export async function signIn(page: Page, email: string) {
  await page.getByLabel('Email address').fill(email);
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/sign-in/magic-link')),
    page.getByRole('button', { name: 'Email me a sign-in link' }).click(),
  ]);
  // Looked at here so that, if the link was not sent, the failure says what the server said.
  // The page itself says only that it could not be sent.
  expect(
    `${answer.status()} ${answer.ok() ? '' : await answer.text().catch(() => '')}`.trim(),
    'the answer to asking for a sign-in link',
  ).toBe('200');
  await expect(page.getByRole('status')).toContainText('Check');
  await page.goto(await emailedLink(email, '/magic-link/verify'));
}

/**
 * A page that is refused something by its own content policy is broken or under attack, and
 * neither should pass quietly: thrown from here, it fails the test that was running.
 */
export function refusals(context: BrowserContext) {
  context.on('console', (said) => {
    // Why an edit was not made is said in the console, and belongs in a failing test's output.
    if (said.text().startsWith('edit not made:')) console.log(said.text());
    if (said.type() === 'error' && said.text().includes('Content Security Policy'))
      throw new Error(`${said.page()?.url()}: ${said.text()}`);
  });
  // Nor should a page fetch other pages before anyone asks for them. The framework does that
  // for every link in view unless the link says not to, and each such fetch draws the whole
  // page on the server: a paper's page set off its editor, for several files, and all the
  // checks before submitting.
  context.on('request', (asked) => {
    if (asked.headers()['next-router-prefetch'])
      throw new Error(`${asked.url()} was fetched before anyone asked for it`);
  });
  // Nor should a page throw something nobody catches, or say in its console that something is
  // wrong with it. (A request that fails says so there too, and tests make requests fail on
  // purpose: those are left alone.) This is how a field's pattern that browsers could not
  // read, and so ignored, was found.
  context.on('weberror', (failed) => {
    throw new Error(`${failed.page()?.url()}: ${failed.error().message}`);
  });
  context.on('console', (said) => {
    if (said.type() === 'error' && !said.text().startsWith('Failed to load resource'))
      throw new Error(`${said.page()?.url()}: ${said.text()}`);
    // One warning is refused too: the visual editor's library saying a caret was put where no
    // text can go. Such a caret is not drawn, and typing lands somewhere else.
    if (said.text().startsWith('TextSelection endpoint not pointing into a node'))
      throw new Error(`${said.page()?.url()}: ${said.text()}`);
  });
}

let people = 0;
/** The test now running, and the browser windows it has opened through `person`. */
let running = '';
const opened: BrowserContext[] = [];
export async function person(browser: Browser, who: string) {
  // The runner does not close what a test opens this way. Left open, a test's pages stay
  // connected and keep asking for builds and tickets under every later test. So the first
  // person of a test closes the last test's windows. (The last test's close with the browser.)
  if (running !== test.info().testId) {
    running = test.info().testId;
    await Promise.all(opened.splice(0).map((context) => context.close()));
  }
  // Sign-in is rate-limited per client address (five links a minute). Each person in a test is
  // a different client, so each gets an address of their own, as a proxy in front would report.
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++people}`;
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
  refusals(context);
  opened.push(context);
  const page = await context.newPage();
  return { page, email: address(who) };
}

/** The line the caret is on in the source view. */
export const caretLine = (page: Page) =>
  page.evaluate(() => {
    const node = getSelection()?.anchorNode;
    const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line');
    return line ? [...line.parentElement!.children].indexOf(line) + 1 : 0;
  });

/** On a file's page, switch to the LaTeX source view. The choice is remembered by the browser. */
/**
 * The text of the source editor without other people's carets: the editor draws each one with
 * the person's name as text, in among the words.
 */
export const sourceText = (page: Page) =>
  page.locator('.editor .cm-content').evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    for (const caret of copy.querySelectorAll('.cm-ySelectionCaret')) caret.remove();
    return copy.textContent ?? '';
  });
export const showSource = (page: Page) =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Source' }).click();

/** On a file's page, switch to the visual view. */
export const showVisual = (page: Page) =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Visual' }).click();

/**
 * Wait until what was just typed into a file has been saved. The status says "Saving" for a
 * moment first; looking only for "saved" could see the one from before the typing.
 */
export async function typingSaved(page: Page) {
  const status = page.getByRole('region', { name: /^Editor for/ }).getByRole('status');
  await expect(status).not.toHaveText('All edits saved.');
  await expect(status).toHaveText('All edits saved.');
}

/** Double-click a word in an editor, as a person would to select it. */
export async function selectWord(page: Page, within: string, word: string) {
  // The file's text arrives a moment after its page does.
  await expect(page.locator(within)).toContainText(word);
  const at = await page.evaluate(
    ([sel, w]) => {
      const walker = document.createTreeWalker(document.querySelector(sel)!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(w);
        if (i < 0) continue;
        n.parentElement!.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + w.length);
        const r = range.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    },
    [within, word] as const,
  );
  if (!at) throw new Error(`"${word}" is not shown in ${within}`);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe(word);
}

/** Put the caret just after a word in an editor, with one click at the word's end. */
export async function clickAfter(page: Page, within: string, word: string) {
  await expect(page.locator(within)).toContainText(word);
  const at = await page.evaluate(
    ([sel, w]) => {
      const walker = document.createTreeWalker(document.querySelector(sel)!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(w);
        if (i < 0) continue;
        n.parentElement!.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + w.length);
        const r = range.getBoundingClientRect();
        return { x: r.right - 1, y: r.y + r.height / 2 };
      }
      return null;
    },
    [within, word] as const,
  );
  if (!at) throw new Error(`"${word}" is not shown in ${within}`);
  await page.mouse.click(at.x, at.y);
}

/** Everything axe can check against WCAG 2.1 A and AA on the page as it stands. */
export async function audit(page: Page, what: string) {
  // On a client-side navigation the new page is drawn a moment (tens of milliseconds) before its
  // <title> is put in; a full load has it from the first byte. Audit the page once it is whole.
  await expect(page).toHaveTitle(/\S/);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    violations.map(
      (v) => `${what}: ${v.id} (${v.help}) at ${v.nodes.map((n) => n.target).join('; ')}`,
    ),
  ).toEqual([]);
}

/**
 * What sticks out past the right edge of a narrow window, so that the page has to be scrolled
 * sideways to read it. Things that scroll sideways within themselves are allowed to: a wide
 * table, a line of source, a page of the PDF.
 */
export const sticksOut = (page: Page) =>
  page.evaluate(() => {
    const wide = document.documentElement.scrollWidth - window.innerWidth;
    if (wide <= 1) return [];
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
      }
      return false;
    };
    const out: string[] = [`the page is ${wide}px wider than the window`];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= window.innerWidth + 1 || inScroller(el)) continue;
      // The outermost culprits only.
      if ([...out].some((o) => o.includes(`<${el.parentElement?.tagName.toLowerCase()}`))) continue;
      out.push(
        `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}> reaches ${Math.round(r.right)}px: "${(el.textContent ?? '').trim().slice(0, 40)}"`,
      );
      if (out.length > 6) break;
    }
    return out;
  });

/**
 * A drop as the browser makes it: a dragover and then a drop, at the middle of the element,
 * carrying a file (given as base64) and/or words. Says whether each was cancelled: one that is
 * not makes the browser open a dropped file in the tab, away from the app.
 */
export function dropOn(
  target: Locator,
  what: { file?: { name: string; type: string; base64: string }; text?: string; html?: string },
) {
  return target.evaluate((el, c) => {
    const data = new DataTransfer();
    if (c.file) {
      const bytes = Uint8Array.from(atob(c.file.base64), (ch) => ch.charCodeAt(0));
      data.items.add(new File([bytes], c.file.name, { type: c.file.type }));
    }
    if (c.html) data.setData('text/html', c.html);
    if (c.text) data.setData('text/plain', c.text);
    const box = el.getBoundingClientRect();
    const at = {
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    };
    const over = new DragEvent('dragover', at);
    el.dispatchEvent(over);
    const drop = new DragEvent('drop', at);
    el.dispatchEvent(drop);
    return { over: over.defaultPrevented, drop: drop.defaultPrevented };
  }, what);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A slow line to the sync server: every frame, each way, is held for `line.each` milliseconds,
 * in order. The delay can be changed while the page is open (0 is no delay). Set up before the
 * page that is to be slowed is loaded: it takes hold of the connections of pages loaded after it.
 */
export async function slowLine(page: Page, each = 0) {
  const line = { each };
  const lane = (send: (m: string | Buffer) => void) => {
    let chain = Promise.resolve();
    let last = 0;
    return (m: string | Buffer) => {
      const due = Math.max(Date.now() + line.each, last);
      last = due;
      chain = chain.then(async () => {
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
        send(m);
      });
    };
  };
  await page.routeWebSocket(/:4100/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage(lane((m) => server.send(m)));
    server.onMessage(lane((m) => socket.send(m)));
  });
  return line;
}

/** A paper of three paragraphs and a table, for tests of the visual view over a slow line. */
const SLOW_MAIN = [
  '\\documentclass{article}',
  '\\usepackage{booktabs}',
  '\\begin{document}',
  '\\section{Intro}',
  '',
  'The first paragraph talks about latency in the editor and ends here alphaend.',
  '',
  'Latency stays below forty milliseconds for most edits, and emphasis bravoend.',
  '',
  'The third paragraph is where the person clicks and ends charlieend.',
  '',
  '\\begin{table}[t]',
  '  \\caption{Edits checked per template}',
  '  \\centering',
  '  \\begin{tabular}{@{}lrr@{}}',
  '    \\toprule',
  '    Template & Edits & Bytes \\\\',
  '    \\midrule',
  '    article & 4000 & 0 \\\\',
  '    amsart & 3000 & 0 \\\\',
  '    \\bottomrule',
  '  \\end{tabular}',
  '\\end{table}',
  '',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');
const SLOW_BIB =
  '@book{knuth1984,\n  author = {Donald E. Knuth},\n  title = {The {\\TeX}book},\n  publisher = {Addison-Wesley},\n  year = {1984}\n}\n';

/** Sign in, import the paper above, and open main.tex in the visual view, over a line not yet slowed. */
export async function slowPaper(browser: Browser, who: string) {
  const { page, email } = await person(browser, who);
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `Slow ${who} ${run}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(SLOW_MAIN) },
      { path: 'refs.bib', bytes: Buffer.from(SLOW_BIB) },
    ]),
  );
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByRole('link', { name: 'main.tex' }).first()).toBeVisible();
  const paper = page.url();
  const line = await slowLine(page);
  await page.goto(paper);
  await page.getByRole('link', { name: 'main.tex' }).first().click();
  await expect(page.locator('.editor .visual .ProseMirror')).toContainText('charlieend');
  await expect(page.getByRole('region', { name: /^Editor for/ }).getByRole('status')).toHaveText(
    'All edits saved.',
    { timeout: 30_000 },
  );
  return { page, line };
}
