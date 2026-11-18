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
  const page = await context.newPage();
  return { page, email: address(who) };
}
