// Files larger than a function may take or send (4.5 MB on Vercel, docs/deploy.md), through the
// real pages: a ZIP imported, a file added, a PDF and two ZIPs downloaded. Locally nothing limits
// a request, so these tests look at where the bytes went: none may pass through the app in one
// piece. Needs the services in infra/compose.yaml.
import { expect, type Page, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, writeZip } from '../../packages/server/src/archive';
import { blobStore } from '../../packages/server/src/blobs';
import { connect } from '../../packages/server/src/db';
import { person, run, signIn } from './helpers';

const FUNCTION_LIMIT = 4_500_000;
const STORE = process.env.S3_ENDPOINT ?? 'http://localhost:8333';
const MAIN = '\\documentclass{article}\n\\begin{document}\nBig.\n\\end{document}\n';

/** Every request a page makes to the app that carries a body, and every PUT to the store. */
function watch(page: Page) {
  const toApp: { url: string; bytes: number }[] = [];
  const toStore: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.origin === STORE && r.method() === 'PUT') toStore.push(r.url());
    else if (url.origin === new URL(page.url() || 'http://localhost:3100').origin)
      toApp.push({ url: r.url(), bytes: r.postDataBuffer()?.length ?? 0 });
  });
  return { toApp, toStore };
}

test('large uploads go to the store, and large downloads come from it or are streamed', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await person(browser, 'large-owner');
  const page = owner.page;
  const sent = watch(page);
  const dir = mkdtempSync(join(tmpdir(), 'paperweave-e2e-'));
  const noise = randomBytes(6_000_000);
  const name = `Large ${run}`;
  const zip = join(dir, `${name}.zip`);
  writeFileSync(
    zip,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'figs/noise.png', bytes: noise },
    ]),
  );
  expect(readFileSync(zip).length).toBeGreaterThan(FUNCTION_LIMIT);

  // Import: the ZIP is put in the store, and the app is told only where.
  await page.goto('/sign-in');
  await signIn(page, owner.email);
  await page.getByLabel('Or import a ZIP of a LaTeX project').setInputFiles(zip);
  await page.getByRole('button', { name: 'Import ZIP' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const paper = page.url();
  const projectId = paper.split('/').at(-1)!;
  expect(sent.toStore).toHaveLength(1);
  expect(Math.max(...sent.toApp.map((r) => r.bytes))).toBeLessThan(FUNCTION_LIMIT);
  await expect(page.getByRole('row', { name: /figs\/noise\.png/ })).toBeVisible();

  // The temporary object is gone once the paper exists.
  const tmp = await fetch(
    `${STORE}/${process.env.S3_BUCKET ?? 'paperweave'}?list-type=2&prefix=tmp/`,
  );
  const keys = [...(await tmp.text()).matchAll(/<Key>(tmp\/[^<]*)<\/Key>/g)].map((m) => m[1]);
  expect(keys.some((k) => sent.toStore[0].includes(k))).toBe(false);

  // Add a file over the limit.
  const big = randomBytes(5_000_000);
  writeFileSync(join(dir, 'big.dat'), big);
  await page.getByLabel('Name, with folders if you like').fill('data/big.dat');
  await page.getByLabel(/^A file to upload/).setInputFiles(join(dir, 'big.dat'));
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByRole('status')).toHaveText('Added data/big.dat.');
  expect(sent.toStore).toHaveLength(2);
  expect(Math.max(...sent.toApp.map((r) => r.bytes))).toBeLessThan(FUNCTION_LIMIT);

  // A small file is posted with the form, as it always was.
  writeFileSync(join(dir, 'small.txt'), 'small\n');
  await page.getByLabel('Name, with folders if you like').fill('data/small.txt');
  await page.getByLabel(/^A file to upload/).setInputFiles(join(dir, 'small.txt'));
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByRole('status')).toHaveText('Added data/small.txt.');
  expect(sent.toStore).toHaveLength(2);

  // A file over the limit of 50 MB is refused by the page, before anything is sent.
  writeFileSync(join(dir, 'huge.dat'), Buffer.alloc(50_000_001));
  await page.getByLabel('Name, with folders if you like').fill('data/huge.dat');
  await page.getByLabel(/^A file to upload/).setInputFiles(join(dir, 'huge.dat'));
  await page.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'too large' })).toBeVisible();
  expect(sent.toStore).toHaveLength(2);

  // The export is streamed: it has no length of its own, and holds every byte.
  const exported = await page.request.get(`/projects/${projectId}/export`);
  expect(exported.headers()['content-length']).toBeUndefined();
  const back = await readZip(new Uint8Array(await exported.body()));
  expect(
    Buffer.from(back.entries.find((e) => e.path === 'figs/noise.png')!.bytes).equals(noise),
  ).toBe(true);
  expect(Buffer.from(back.entries.find((e) => e.path === 'data/big.dat')!.bytes).equals(big)).toBe(
    true,
  );

  // A revision (the second: the export cut the first), with a built PDF of 5 MB (put there directly: building one takes a worker).
  await page.getByLabel('Name for the paper as it is now').fill('Large');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as revision 2.');
  const pool = connect(
    process.env.DATABASE_URL ?? 'postgres://paperweave:paperweave@localhost:5432/paperweave',
  );
  const store = blobStore({
    S3_ENDPOINT: STORE,
    S3_BUCKET: process.env.S3_BUCKET ?? 'paperweave',
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'dev',
    S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'dev',
  });
  const pdf = Buffer.concat([Buffer.from('%PDF-1.5\n'), randomBytes(5_000_000)]);
  const small = Buffer.concat([Buffer.from('%PDF-1.5\n'), randomBytes(2_000)]);
  const revision = (
    await pool.query(
      'select id from revisions where project_id = $1 order by number desc limit 1',
      [projectId],
    )
  ).rows[0].id;
  const built = async (bytes: Buffer, revisionId: string | null) =>
    (
      await pool.query(
        `insert into builds (project_id, status, revision_id, pdf_digest, finished_at)
         values ($1, 'succeeded', $2, $3, now()) returning id`,
        [projectId, revisionId, await store.put(bytes)],
      )
    ).rows[0].id as string;
  const bigBuild = await built(pdf, revision);
  const smallBuild = await built(small, null);
  await pool.end();

  // The revision's PDF: a redirect to a signed address in the store, which sends it with the
  // paper's name.
  const asked = await page.request.get(`/projects/${projectId}/revisions/${revision}/pdf`, {
    maxRedirects: 0,
  });
  expect(asked.status()).toBe(303);
  const to = new URL(asked.headers().location);
  expect(to.origin).toBe(STORE);
  expect(to.searchParams.get('X-Amz-Signature')).toBeTruthy();
  const sentFromStore = await fetch(to);
  expect(Buffer.from(await sentFromStore.arrayBuffer()).equals(pdf)).toBe(true);
  expect(sentFromStore.headers.get('content-type')).toBe('application/pdf');
  expect(sentFromStore.headers.get('content-disposition')).toContain(`filename="${name} r2.pdf"`);
  // And a browser page follows it: the store answers its origin, and the page's policy allows it.
  const fetched = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return { ok: res.ok, length: (await res.arrayBuffer()).byteLength };
  }, `/projects/${projectId}/revisions/${revision}/pdf`);
  expect(fetched).toEqual({ ok: true, length: pdf.length });

  // The build's PDF, which the pages show in place: inline.
  const buildPdf = await page.request.get(`/projects/${projectId}/builds/${bigBuild}/pdf`, {
    maxRedirects: 0,
  });
  expect(buildPdf.status()).toBe(303);
  const shown = await fetch(buildPdf.headers().location);
  expect(shown.headers.get('content-disposition')).toMatch(/^inline;/);
  expect(Buffer.from(await shown.arrayBuffer()).equals(pdf)).toBe(true);

  // A small one is still sent from the app, and kept by the browser as it was.
  const direct = await page.request.get(`/projects/${projectId}/builds/${smallBuild}/pdf`, {
    maxRedirects: 0,
  });
  expect(direct.status()).toBe(200);
  expect(direct.headers()['cache-control']).toBe('private, no-cache');
  expect((await direct.body()).equals(small)).toBe(true);

  // Someone who is not on the paper is sent nowhere: no address is made for them.
  const outsider = await person(browser, 'large-outsider');
  await outsider.page.goto('/sign-in');
  await signIn(outsider.page, outsider.email);
  const refused = await outsider.page.request.get(
    `/projects/${projectId}/revisions/${revision}/pdf`,
    { maxRedirects: 0 },
  );
  expect(refused.status()).toBe(404);
  expect(refused.headers().location).toBeUndefined();

  // The revision's ZIP is streamed too, and holds the same bytes.
  const revZip = await page.request.get(`/projects/${projectId}/revisions/${revision}/zip`);
  expect(revZip.headers()['content-length']).toBeUndefined();
  const revBack = await readZip(new Uint8Array(await revZip.body()));
  expect(
    Buffer.from(revBack.entries.find((e) => e.path === 'figs/noise.png')!.bytes).equals(noise),
  ).toBe(true);
});
