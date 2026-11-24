// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
// A paper of many edited files, with every call to the store taking 30 ms, as if it were far
// away. One file after another, saving, downloading and comparing wait that long for each file.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readZip, writeZip } from './archive.ts';
import { READS } from './batch.ts';
import { type BlobStore, blobStore } from './blobs.ts';
import { createFile } from './files.ts';
import { exportZipStream, importZip, listFiles } from './import.ts';
import { diffRevisions, exportRevision, exportRevisionStream, saveRevision } from './revisions.ts';
import { editFile } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';

const FILES = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MAIN = '\\documentclass{article}\n\\begin{document}\n\\end{document}\n';
const names = Array.from(
  { length: FILES },
  (_, i) => `sections/s${String(i).padStart(2, '0')}.tex`,
);
const original = (i: number) => `% ${i}\nOnce.\n`;
const edited = (i: number) => `${original(i)}Edited ${names[i]}.\n`;

const direct = blobStore(TEST_ENV);
/** The store, a little way off: each call takes about 30 ms, and how many are at once is counted. */
function far(ms = 30) {
  const seen = {
    calls: { put: 0, get: 0 },
    now: { put: 0, get: 0 },
    peak: { put: 0, get: 0 },
  };
  const slow = async <T>(kind: 'put' | 'get', call: () => Promise<T>) => {
    const n = ++seen.calls[kind];
    seen.peak[kind] = Math.max(seen.peak[kind], ++seen.now[kind]);
    // A little different for each, so that answers do not come back in the order asked for.
    await sleep(ms + (n % 5) * 4);
    try {
      return await call();
    } finally {
      seen.now[kind]--;
    }
  };
  const store: BlobStore = {
    ...direct,
    put: (bytes) => slow('put', () => direct.put(bytes)),
    get: (digest) => slow('get', () => direct.get(digest)),
  };
  return { store, seen };
}

let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let paper: string;
let ids: Record<string, string>;

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    ...names.map((path, i) => ({ path, bytes: Buffer.from(original(i)) })),
  ]);
  [{ id: paper }] = await importZip(t.pool, direct, owner.id, zip, 'Batching');
  ids = Object.fromEntries((await listFiles(t.pool, owner.id, paper)).map((f) => [f.path, f.id]));
  // Every file edited, so that every file's text is in its log and not yet in the store.
  for (const path of names)
    await editFile(t.pool, direct, ids[path], owner.id, (y) => {
      y.insert(y.length, `Edited ${path}.\n`);
    });
});
afterAll(() => t.close());

/** Count the statements the pool is given while `fn` runs. */
async function counting<T>(fn: () => Promise<T>) {
  const query = t.pool.query.bind(t.pool);
  let n = 0;
  (t.pool as { query: unknown }).query = (...args: unknown[]) => {
    n++;
    return (query as (...a: unknown[]) => unknown)(...args);
  };
  try {
    return { result: await fn(), statements: n };
  } finally {
    (t.pool as { query: unknown }).query = query;
  }
}
async function timed<T>(fn: () => Promise<T>) {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}
const collect = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());

test('saving a revision of a paper of edited files reads their logs together and stores 16 at a time', async () => {
  const slow = far();
  const { result, statements } = await counting(() =>
    timed(() => saveRevision(t.pool, slow.store, owner.id, paper, 'First')),
  );
  // One file after another this is 32 statements, and 30 puts in a row over 1.1 s.
  expect(statements).toBeLessThan(10);
  expect(result.ms).toBeLessThan(600);
  expect(slow.seen.peak.put).toBeGreaterThan(1);
  expect(slow.seen.peak.put).toBeLessThanOrEqual(16);
  // What is stored is what it was: each file's text, by its digest, and the size it is said to be.
  const { rows } = await t.pool.query(
    `select rf.path, rf.digest, f.size from revision_files rf join files f on f.id = rf.file_id
     where rf.revision_id = $1`,
    [result.result.id],
  );
  for (const [i, path] of names.entries()) {
    const row = rows.find((r) => r.path === path);
    expect(row.digest).toBe(sha(Buffer.from(edited(i))));
    expect(row.size).toBe(Buffer.byteLength(edited(i)));
  }
});

test('the ZIP of a revision is the same bytes, whichever order the store answers in', async () => {
  const { id } = (await t.pool.query('select id from revisions where number = 1')).rows[0];
  const slow = far();
  const files = [
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    ...names.map((path, i) => ({ path, bytes: Buffer.from(edited(i)) })),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  const expected = await writeZip(files);
  const whole = await exportRevision(t.pool, slow.store, owner.id, paper, id);
  expect(Buffer.from(whole.zip).equals(Buffer.from(expected))).toBe(true);
  const streamed = await exportRevisionStream(t.pool, far().store, owner.id, paper, id);
  expect(Buffer.from(await collect(streamed.zip)).equals(Buffer.from(expected))).toBe(true);
  // Read together, but never more than sixteen at a time.
  expect(slow.seen.peak.get).toBeGreaterThan(1);
  expect(slow.seen.peak.get).toBeLessThanOrEqual(16);
  // And with more to put in beside the files, those come after them, as they did.
  const extra = [{ path: 'paperweave-review.json', bytes: Buffer.from('{}') }];
  const more = await exportRevision(t.pool, slow.store, owner.id, paper, id, false, extra);
  expect(Buffer.from(more.zip).equals(Buffer.from(await writeZip([...files, ...extra])))).toBe(
    true,
  );
});

test('downloading a revision of many files does not wait for each file in turn', async () => {
  const { id } = (await t.pool.query('select id from revisions where number = 1')).rows[0];
  const slow = far();
  const { ms } = await timed(() => exportRevision(t.pool, slow.store, owner.id, paper, id));
  // One after another: 31 reads of 30 ms or more.
  expect(ms).toBeLessThan(500);
});

test('Download ZIP of a paper of edited files is quick when the store is far', async () => {
  const slow = far();
  const { ms, result } = await timed(async () =>
    collect(await exportZipStream(t.pool, slow.store, owner.id, paper)),
  );
  // One after another: 30 puts and 31 reads, well over 1.8 s.
  expect(ms).toBeLessThan(700);
  const read = await readZip(result);
  expect(read.entries.length).toBe(FILES + 1);
});

test('a diff of two revisions reads the files that changed together', async () => {
  const before = (await t.pool.query('select id from revisions where number = 1')).rows[0].id;
  for (const i of [0, 3, 5, 7, 9, 11, 13, 17, 19, 23, 29])
    await editFile(t.pool, direct, ids[names[i]], owner.id, (y) => y.insert(0, `% changed\n`));
  const after = (await saveRevision(t.pool, direct, owner.id, paper, 'Second')).id;
  const slow = far();
  const { ms, result } = await timed(() =>
    diffRevisions(t.pool, slow.store, owner.id, paper, before, after),
  );
  expect(result.files.length).toBe(11);
  expect(result.files.every((f) => f.status === 'changed' && f.lines)).toBe(true);
  expect(result.files[0].path).toBe(names[0]);
  // One after another: 22 reads of 30 ms or more.
  expect(ms).toBeLessThan(500);
  expect(slow.seen.peak.get).toBeLessThanOrEqual(16);
  expect(slow.seen.peak.get).toBeGreaterThan(1);
});

test('a diff that adds twenty files reads them sixteen at a time', async () => {
  const before = (await saveRevision(t.pool, direct, owner.id, paper, 'Before the twenty')).id;
  for (let i = 0; i < 20; i++)
    await createFile(t.pool, direct, owner.id, paper, `added/a${i}.tex`, Buffer.from(`new ${i}\n`));
  const after = (await saveRevision(t.pool, direct, owner.id, paper, 'After the twenty')).id;
  const slow = far();
  const { result } = await timed(() =>
    diffRevisions(t.pool, slow.store, owner.id, paper, before, after),
  );
  expect(result.files).toHaveLength(20);
  expect(result.files.every((f) => f.status === 'added' && f.lines?.length === 1)).toBe(true);
  expect(slow.seen.calls.get).toBe(20);
  expect(slow.seen.peak.get).toBeLessThanOrEqual(READS);
  expect(slow.seen.peak.get).toBeGreaterThan(1);
});
