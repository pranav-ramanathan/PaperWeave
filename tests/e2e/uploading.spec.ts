// What the upload forms say while a large file goes to the store, and when it does not get there.
// Needs the services in infra/compose.yaml.
import { expect, type Page, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../packages/server/src/archive';
import { person, run, signIn } from './helpers';

const STORE = process.env.S3_ENDPOINT ?? 'http://localhost:8333';
const MAIN = '\\documentclass{article}\n\\begin{document}\nBig.\n\\end{document}\n';

/** A project ZIP of about 6 MB, over what a function takes. */
async function bigZip(name: string) {
  const zip = join(mkdtempSync(join(tmpdir(), 'paperweave-e2e-')), `${name}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'figs/noise.png', bytes: randomBytes(6_000_000) },
    ]),
  );
  return zip;
}

async function signedIn(browser: Parameters<typeof person>[0], who: string) {
  const owner = await person(browser, who);
  await owner.page.goto('/sign-in');
  await signIn(owner.page, owner.email);
  return owner.page;
}

const importZip = async (page: Page, zip: string) => {
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
};

test('a large upload says it is uploading', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, 'uploading');
  const name = `Uploading ${run}`;
  await page.route(`${STORE}/**`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await new Promise((r) => setTimeout(r, 3_000));
    await route.fallback();
  });
  await importZip(page, await bigZip(name));
  await expect(page.getByRole('progressbar', { name: 'Uploaded so far' })).toBeVisible();
  await expect(page.getByText(`Uploading ${name}.zip`)).toBeVisible();
  // Bytes are going, so the page is not "waiting for the server".
  await expect(page.locator('#waiting')).toHaveText('');
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

test("an upload that does not reach the store, or is not started, says so in the page's words", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, 'uploadfails');
  const name = `Upload fails ${run}`;
  const zip = await bigZip(name);
  const alert = (hasText: string) => page.getByRole('alert').filter({ hasText });

  await page.route(`${STORE}/**`, (route) =>
    route.request().method() === 'PUT' ? route.abort('connectionfailed') : route.fallback(),
  );
  await importZip(page, zip);
  await expect(alert('did not reach the store')).toBeVisible();
  await expect(alert('Failed to fetch')).toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page.unroute(`${STORE}/**`);

  await page.route('**/api/uploads', (route) => route.abort('connectionfailed'));
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(alert('The server did not answer')).toBeVisible();
  await page.unroute('**/api/uploads');

  // The button is free again.
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

test('an upload that stops is given up', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await signedIn(browser, 'uploadstops');
  await page.route(`${STORE}/**`, (route) =>
    route.request().method() === 'PUT' ? new Promise<void>(() => {}) : route.fallback(),
  );
  await importZip(page, await bigZip(`Upload stops ${run}`));
  await expect(page.getByRole('alert').filter({ hasText: 'did not reach the store' })).toBeVisible({
    timeout: 45_000,
  });
});
