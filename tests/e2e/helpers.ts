// Shared by the browser tests that need a signed-in person.
import { type Browser, expect, type Page } from '@playwright/test';

const MAIL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
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
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('Check');
  await page.goto(await emailedLink(email, '/magic-link/verify'));
}

let people = 0;
export async function person(browser: Browser, who: string) {
  // Sign-in is rate-limited per client address (five links a minute). Each person in a test is
  // a different client, so each gets an address of their own, as a proxy in front would report.
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++people}`;
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
  // A page that is refused something by its own content policy is broken or under attack, and
  // neither should pass quietly: thrown from here, it fails the test that was running.
  context.on('console', (said) => {
    if (said.type() === 'error' && said.text().includes('Content Security Policy'))
      throw new Error(`${said.page()?.url()}: ${said.text()}`);
  });
  const page = await context.newPage();
  return { page, email: address(who) };
}

/** On a file's page, switch to the LaTeX source view. A .tex file opens in the visual view. */
export const showSource = (page: Page) =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Source' }).click();

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
