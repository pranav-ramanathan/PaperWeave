// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LIMITS, writeZip, zipStream } from './archive.ts';
import { type BlobStore, blobStore } from './blobs.ts';
import { exportRevisionStream, saveRevision } from './revisions.ts';
import { exportZip, exportZipStream, importZip, listFiles } from './import.ts';
import { acceptInvitation, invite } from './projects.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { addUploaded, importUploaded, startUpload } from './uploads.ts';

const store = blobStore(TEST_ENV);
const MAIN = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let viewer: { id: string; email: string };
let outsider: { id: string };
let paperId: string;
// The store in infra/compose.yaml has no identities, so it takes anything, signed or not. Run
// against one that has (S3_ENDPOINT), these two tests are about what the signature holds to.
const strict =
  (await fetch(`${TEST_ENV.S3_ENDPOINT}/${TEST_ENV.S3_BUCKET}/nothing`)).status === 403;

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  viewer = await t.signIn('viewer@example.org');
  outsider = await t.signIn('outsider@example.org');
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  paperId = (await importZip(t.pool, store, owner.id, zip, 'Uploads'))[0].id;
  const { token } = await invite(t.pool, owner.id, paperId, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
});
afterAll(() => t.close());

/** What a browser does with the address: a PUT of the file, nothing else. */
const put = (url: string, body: Uint8Array) =>
  fetch(url, { method: 'PUT', body: body as BodyInit });
const gone = async (key: string) => (await store.uploadSize(key)) === null;
/** A store that says when its bytes are read. */
const watched = () => {
  const reads: string[] = [];
  const spy: BlobStore = {
    ...store,
    uploadRead: (key) => (reads.push(key), store.uploadRead(key)),
  };
  return { spy, reads };
};

test('an upload is put in the store by the browser, then added to the paper by its key', async () => {
  const bytes = randomBytes(6_000_000); // more than a function takes in a request
  const { key, url } = await startUpload(
    t.pool,
    store,
    owner.id,
    { kind: 'file', projectId: paperId },
    bytes.length,
  );
  expect(key).toMatch(/^tmp\/[0-9a-f-]{36}$/);
  expect((await put(url, bytes)).ok).toBe(true);
  expect(await store.uploadSize(key)).toBe(bytes.length);
  await addUploaded(t.pool, store, owner.id, paperId, key, 'figures/big.png');
  const file = (await listFiles(t.pool, owner.id, paperId)).find(
    (f) => f.path === 'figures/big.png',
  );
  expect(file?.size).toBe(bytes.length);
  expect(Buffer.from((await store.get(file!.digest))!).equals(bytes)).toBe(true);
  // Taken: the temporary object is gone, and cannot be taken again.
  expect(await gone(key)).toBe(true);
  await expect(addUploaded(t.pool, store, owner.id, paperId, key, 'again.png')).rejects.toThrow(
    'did not arrive',
  );
});

test.runIf(strict)('the address takes exactly the size it was made for', async () => {
  const { url } = await startUpload(
    t.pool,
    store,
    owner.id,
    { kind: 'file', projectId: paperId },
    1000,
  );
  expect((await put(url, randomBytes(1001))).ok).toBe(false);
});

test('an upload over the limit is refused before it is read, and removed', async () => {
  const small = { ...LIMITS, fileBytes: 1000 };
  // Refused when the address is asked for, if the size is known.
  await expect(
    startUpload(t.pool, store, owner.id, { kind: 'file', projectId: paperId }, 1001, small),
  ).rejects.toThrow('too large');
  await expect(
    startUpload(t.pool, store, owner.id, { kind: 'zip' }, LIMITS.archiveBytes + 1),
  ).rejects.toThrow('too large');
  // And when it was put there anyway, by an address made without a size.
  const { key, url } = await startUpload(t.pool, store, owner.id, {
    kind: 'file',
    projectId: paperId,
  });
  expect((await put(url, randomBytes(2000))).ok).toBe(true);
  const { spy, reads } = watched();
  await expect(addUploaded(t.pool, spy, owner.id, paperId, key, 'huge.txt', small)).rejects.toThrow(
    'That file is too large.',
  );
  expect(reads).toEqual([]);
  expect(await gone(key)).toBe(true);
  expect((await listFiles(t.pool, owner.id, paperId)).some((f) => f.path === 'huge.txt')).toBe(
    false,
  );
});

test('a ZIP is imported from its key, and the object is removed whether or not the import worked', async () => {
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  const ok = await startUpload(t.pool, store, owner.id, { kind: 'zip' }, zip.length);
  expect((await put(ok.url, zip)).ok).toBe(true);
  const made = await importUploaded(t.pool, store, owner.id, ok.key, 'From upload');
  expect(made).toHaveLength(1);
  expect(made[0].name).toBe('From upload');
  expect(await gone(ok.key)).toBe(true);

  // Not a ZIP at all: the whole import is refused, and nothing is left in tmp/.
  const bad = await startUpload(t.pool, store, owner.id, { kind: 'zip' });
  expect((await put(bad.url, randomBytes(5000))).ok).toBe(true);
  await expect(importUploaded(t.pool, store, owner.id, bad.key, 'Bad')).rejects.toThrow(
    'cannot be imported',
  );
  expect(await gone(bad.key)).toBe(true);
});

test('someone who may not write to a paper gets no address and cannot take an upload for it', async () => {
  for (const who of [outsider, viewer])
    await expect(
      startUpload(t.pool, store, who.id, { kind: 'file', projectId: paperId }, 10),
    ).rejects.toThrow();
  // The owner's upload, key known: not theirs to take into a paper they may not write to.
  const { key, url } = await startUpload(
    t.pool,
    store,
    owner.id,
    { kind: 'file', projectId: paperId },
    4,
  );
  await put(url, Buffer.from('abcd'));
  await expect(addUploaded(t.pool, store, outsider.id, paperId, key, 'x.txt')).rejects.toThrow();
  expect(await store.uploadSize(key)).toBe(4);
  await store.uploadDrop(key);
  // Nor is a key anything but one this site made.
  await expect(
    addUploaded(t.pool, store, owner.id, paperId, 'sha256/00/' + '0'.repeat(64), 'x.txt'),
  ).rejects.toThrow('not one this site made');
});

test('uploads nobody took are swept when they are old, and not before', async () => {
  const { key, url } = await startUpload(t.pool, store, owner.id, { kind: 'zip' });
  await put(url, Buffer.from('x'));
  expect(await store.uploadSweep(3600_000)).toBe(0);
  expect(await store.uploadSize(key)).toBe(1);
  await new Promise((r) => setTimeout(r, 1100));
  expect(await store.uploadSweep(500)).toBeGreaterThanOrEqual(1);
  expect(await gone(key)).toBe(true);
});

test('a signed address to a blob names the download and says what it is, and only that blob', async () => {
  const bytes = randomBytes(5000);
  const digest = await store.put(bytes);
  expect(await store.size(digest)).toBe(5000);
  const url = await store.link(digest, {
    type: 'application/pdf',
    disposition: 'inline; filename="Paper.pdf"',
  });
  const res = await fetch(url);
  expect(res.headers.get('content-type')).toBe('application/pdf');
  expect(res.headers.get('content-disposition')).toBe('inline; filename="Paper.pdf"');
  expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  // The store is private: the same address without its signature is refused.
  if (strict) expect((await fetch(url.split('?')[0])).ok).toBe(false);
});

test('a streamed ZIP has the bytes of the one written whole', async () => {
  const entries = [
    { path: 'a.tex', bytes: Buffer.from(MAIN) },
    { path: 'b/c.bin', bytes: randomBytes(300_000) },
  ];
  const whole = await writeZip(entries);
  expect(Buffer.from(await new Response(zipStream(entries)).arrayBuffer()).equals(whole)).toBe(
    true,
  );
  const exported = await exportZip(t.pool, store, owner.id, paperId);
  const streamed = Buffer.from(
    await new Response(await exportZipStream(t.pool, store, owner.id, paperId)).arrayBuffer(),
  );
  expect(streamed.equals(exported)).toBe(true);
  const rev = await saveRevision(t.pool, store, owner.id, paperId, 'one');
  const { zip } = await exportRevisionStream(t.pool, store, owner.id, paperId, rev.id, true);
  expect((await new Response(zip).arrayBuffer()).byteLength).toBeGreaterThan(0);
});
