// Live editing in the app: two people in one file, a reviewer reading along, and edits made
// while offline. Needs the services in infra/compose.yaml and the sync server.
import { expect, type Page, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { emailedLink, person, run, signIn } from './helpers';

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
  await expect(source(owner.page)).toContainText('\\section{Introduction}');
  await expect(status(owner.page)).toHaveText('All edits saved.');
  await editor.page.goto(owner.page.url());
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

  // A structural edit goes to the server as a command. This one adds a line at the end of the
  // file: the place is "the end of the text", which is the same nine bytes in any file.
  const end = Buffer.from([1, 6, ...Buffer.from('source'), 0]).toString('base64url');
  const command = { key: crypto.randomUUID(), from: end, to: end, expected: '' };
  const headers = { origin: 'http://localhost:3100' };
  const send = (page: Page, data: unknown, url = `${owner.page.url()}/commands`) =>
    page.request.post(url, { headers, data });
  const applied = await send(owner.page, { ...command, replacement: '% by command\n' });
  expect([applied.status(), await applied.json()]).toEqual([200, { result: 'applied' }]);
  await expect(source(editor.page)).toContainText('% by command');
  // Sent again, as a retry would be, it is not applied again.
  const retried = await send(owner.page, { ...command, replacement: '% by command\n' });
  expect([retried.status(), await retried.json()]).toEqual([200, { result: 'duplicate' }]);
  // One whose text has moved on is refused, and the answer carries the text as it stands.
  const stale = await send(owner.page, {
    key: crypto.randomUUID(),
    from: end,
    to: end,
    expected: 'something else',
    replacement: 'x',
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).text).toMatch(/% by command\n$/);
  // A reviewer, a request from another site, another paper's address, and nonsense are refused.
  const fresh = () => ({ ...command, key: crypto.randomUUID(), replacement: 'NO' });
  expect((await send(reviewer.page, fresh())).status()).toBe(403);
  expect(
    (
      await owner.page.request.post(`${owner.page.url()}/commands`, {
        headers: { origin: 'https://evil.example' },
        data: fresh(),
      })
    ).status(),
  ).toBe(403);
  const elsewhere = owner.page
    .url()
    .replace(/projects\/[0-9a-f-]+/, 'projects/00000000-0000-4000-8000-000000000000');
  expect((await send(owner.page, fresh(), `${elsewhere}/commands`)).status()).toBe(404);
  expect((await send(owner.page, { ...fresh(), from: '!!' })).status()).toBe(400);
  expect((await send(owner.page, 'not json at all')).status()).toBe(400);
  await expect(source(editor.page)).not.toContainText('NO');

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
    '% written offline\n% editor too\n% owner was here\n' + original + '% by command\n',
  );
  for (const f of files)
    if (f.path !== 'sections/intro.tex') expect(bytes(f.path).equals(f.bytes), f.path).toBe(true);
});
