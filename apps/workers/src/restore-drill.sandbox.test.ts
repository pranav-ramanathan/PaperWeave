// The restore drill: a database that holds a real paper is backed up with the script an
// operator would use, restored into an empty database, and everything about the paper is
// asked for again from the restored copy. Needs the services of infra/compose.yaml, the
// toolchain image and Docker. Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  acceptProposal,
  blobStore,
  checkBlobs,
  editFile,
  exportRevision,
  exportZip,
  importZip,
  latestBuilds,
  listFiles,
  listProposals,
  listRevisions,
  listThreads,
  loadUpdates,
  propose,
  requestBuild,
  revisionPdf,
  saveRevision,
  startThread,
  TEXT,
  writeZip,
} from '@paperweave/server';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { FIXTURES } from '../../../packages/latex/src/testutil.ts';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { buildNext, imageId } from './builder.ts';

const INFRA = join(import.meta.dirname, '../../../infra');
const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
let restored: pg.Pool | undefined;
const drill = `drill_${Date.now().toString(36)}`;

beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await restored?.end();
  const admin = new pg.Pool({ connectionString: TEST_ENV.DATABASE_URL, max: 1 });
  await admin.query(`drop database if exists ${drill}`);
  await admin.end();
  await t.close();
});

test('a paper comes back whole from a backup', async () => {
  const owner = await t.signIn('owner@example.org');
  // A real paper with a history: imported, edited, saved, built, commented on, changed by an
  // accepted proposal, and edited again since the last revision.
  const root = join(FIXTURES, 'ieee-multifile');
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(root, p), bytes: readFileSync(p) });
    }
  };
  walk(root);
  const [paper] = await importZip(t.pool, store, owner.id, await writeZip(files), 'Drill');
  const intro = (await listFiles(t.pool, owner.id, paper.id)).find(
    (f) => f.path === 'sections/intro.tex',
  )!.id;
  const ends = async (words: string) => {
    const doc = new Y.Doc();
    for (const u of await loadUpdates(t.pool, store, intro)) Y.applyUpdate(doc, u);
    const text = doc.getText(TEXT);
    const at = text.toString().indexOf(words);
    const rel = (i: number, side: number) =>
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, i, side));
    return { from: rel(at, 0), to: rel(at + words.length, -1) };
  };
  await editFile(t.pool, store, intro, owner.id, (text) => text.insert(0, '% edited once\n'));
  const named = await saveRevision(t.pool, store, owner.id, paper.id, 'Before the drill');
  await requestBuild(t.pool, owner.id, paper.id, { revisionId: named.id });
  expect(await buildNext(t.pool, store, imageId())).toBe(true);
  await startThread(t.pool, store, owner.id, paper.id, intro, {
    ...(await ends('opposite')),
    body: 'Opposite to what?',
  });
  const proposal = await propose(t.pool, store, owner.id, paper.id, intro, {
    ...(await ends('organised')),
    replacement: 'arranged',
  });
  await acceptProposal(t.pool, store, owner.id, paper.id, proposal);
  await editFile(t.pool, store, intro, owner.id, (text) => text.insert(0, '% edited since\n'));

  /** Everything a person could ask of the paper, from one database. */
  const everything = async (pool: pg.Pool) => {
    const revisions = await listRevisions(pool, owner.id, paper.id);
    return {
      files: (await listFiles(pool, owner.id, paper.id)).map((f) => [f.path, f.digest, f.size]),
      revisions: revisions.map((r) => [r.number, r.kind, r.name, r.hasPdf]),
      // The saved revision, byte for byte, and the PDF built from it.
      named: Buffer.from(
        (await exportRevision(pool, store, owner.id, paper.id, named.id)).zip,
      ).toString('base64'),
      pdf: Buffer.from(await revisionPdf(pool, store, owner.id, paper.id, named.id)).length,
      build: (await latestBuilds(pool, owner.id, paper.id)).lastGood?.id,
      threads: (await listThreads(pool, store, owner.id, paper.id)).map((th) => [
        th.excerpt,
        th.state,
        th.comments.map((c) => c.body),
      ]),
      proposals: (await listProposals(pool, store, owner.id, paper.id)).map((p) => [
        p.expected,
        p.replacement,
        p.status,
        p.now,
      ]),
      // The text as it stands, edits since the last revision included.
      intro: (await loadUpdates(pool, store, intro)).length,
    };
  };
  const before = await everything(t.pool);
  expect(before.proposals).toEqual([['organised', 'arranged', 'accepted', 'arranged']]);
  const text = async (pool: pg.Pool) => {
    const zip = await exportZip(pool, store, owner.id, paper.id);
    return Buffer.from(zip).toString('base64');
  };

  // The backup, and the restore into a database that has never held anything.
  const dump = join(mkdtempSync(join(tmpdir(), 'paperweave-drill-')), 'backup.dump');
  const source = new URL(t.url).pathname.slice(1);
  execFileSync(join(INFRA, 'backup.sh'), [source, dump], { stdio: 'pipe' });
  expect(statSync(dump).size).toBeGreaterThan(10_000);
  const admin = new pg.Pool({ connectionString: TEST_ENV.DATABASE_URL, max: 1 });
  await admin.query(`create database ${drill}`);
  await admin.end();
  execFileSync(join(INFRA, 'restore.sh'), [dump, drill], { stdio: 'pipe' });
  const url = new URL(TEST_ENV.DATABASE_URL);
  url.pathname = `/${drill}`;
  restored = new pg.Pool({ connectionString: url.href });

  // Everything the restored database points at is in the object store, and is what it says.
  const blobs = await checkBlobs(restored, store);
  expect(blobs.referenced).toBeGreaterThan(8);
  expect(blobs).toMatchObject({ missing: [], corrupt: [] });
  // The paper is as it was: files, revisions, the saved ZIP and its PDF, review, and the text
  // typed since the last revision.
  expect(await everything(restored)).toEqual(before);
  const live = await text(t.pool);
  expect(await text(restored)).toBe(live);

  // And it is a working copy, not a museum piece: it takes a new edit and a new revision.
  await editFile(restored, store, intro, owner.id, (y) => y.insert(0, '% after the restore\n'));
  const after = await saveRevision(restored, store, owner.id, paper.id, 'After the drill');
  expect(after.number).toBe(
    Math.max(...(await listRevisions(t.pool, owner.id, paper.id)).map((r) => r.number)) + 1,
  );
  expect(await text(restored)).not.toBe(live);

  // A store that has lost something is found out.
  const [{ digest }] = (
    await restored.query("select digest from all_files where path = 'refs.bib' limit 1")
  ).rows;
  const holey = { ...store, get: async (d: string) => (d === digest ? null : store.get(d)) };
  expect((await checkBlobs(restored, holey)).missing).toEqual([digest]);
}, 240_000);
