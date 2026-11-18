// Needs Docker, the TeX image and the services in infra/compose.yaml. Run: pnpm test:sandbox
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  acceptInvitation,
  appendUpdate,
  blobStore,
  buildOutput,
  importZip,
  invite,
  latestBuilds,
  listFiles,
  loadUpdates,
  requestBuild,
  TEXT,
  writeZip,
} from '@paperweave/server';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { FIXTURES } from '../../../packages/latex/src/testutil.ts';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { buildNext, imageId } from './builder.ts';

const store = blobStore(TEST_ENV);
const image = imageId();
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let viewer: { id: string; email: string };
let outsider: { id: string };

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  viewer = await t.signIn('viewer@example.org');
  outsider = await t.signIn('outsider@example.org');
});
afterAll(() => t.close());

async function paper(name = 'article-basic') {
  const root = join(FIXTURES, name);
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(root, p), bytes: readFileSync(p) });
    }
  };
  walk(root);
  const [project] = await importZip(t.pool, store, owner.id, await writeZip(files), name);
  const main = (await listFiles(t.pool, owner.id, project.id)).find((f) => f.path === 'main.tex')!;
  return { project: project.id, main: main.id };
}

/** Edit a file the way a connected editor would: one update appended to its log. */
async function edit(file: string, change: (text: Y.Text) => void) {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  const before = Y.encodeStateVector(doc);
  change(doc.getText(TEXT));
  expect(
    await appendUpdate(t.pool, file, owner.id, Y.encodeStateAsUpdate(doc, before)),
  ).not.toBeNull();
}

/** Ask for a build and run the worker until it is done. */
async function build(project: string, img = image) {
  const id = await requestBuild(t.pool, owner.id, project);
  expect(await buildNext(t.pool, store, img)).toBe(true);
  const { latest } = await latestBuilds(t.pool, owner.id, project);
  expect(latest!.id).toBe(id);
  return latest!;
}
const digest = async (id: string) =>
  (await t.pool.query('select pdf_digest from builds where id = $1', [id])).rows[0].pdf_digest;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test('a paper builds to a PDF, and the same inputs are never built twice', async () => {
  const { project, main } = await paper();
  const first = await build(project);
  expect(first).toMatchObject({ status: 'succeeded', hasPdf: true, cached: false, stale: false });
  expect(first.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const pdf = await buildOutput(t.pool, store, owner.id, project, first.id, 'pdf');
  expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
  expect(
    (await buildOutput(t.pool, store, owner.id, project, first.id, 'log')).length,
  ).toBeGreaterThan(100);
  expect(await buildNext(t.pool, store, image)).toBe(false);

  // Nothing changed: the result comes from the cache.
  const again = await build(project);
  expect(again).toMatchObject({ status: 'succeeded', cached: true });
  expect(await digest(again.id)).toBe(await digest(first.id));

  // An edit makes the old build out of date and the next one a real build.
  await edit(main, (text) =>
    text.insert(text.toString().indexOf('Collaborative'), 'Fresh words. '),
  );
  expect((await latestBuilds(t.pool, owner.id, project)).latest!.stale).toBe(true);
  const edited = await build(project);
  expect(edited).toMatchObject({ status: 'succeeded', cached: false, stale: false });
  expect(await digest(edited.id)).not.toBe(await digest(first.id));

  // So does a different toolchain image, and a different compiler.
  expect((await build(project, 'sha256:some-other-image')).cached).toBe(false);
  await t.pool.query("update projects set compiler = 'xelatex' where id = $1", [project]);
  expect(await build(project)).toMatchObject({ status: 'succeeded', cached: false });
  await t.pool.query("update projects set compiler = 'lualatex' where id = $1", [project]);
  expect(await build(project)).toMatchObject({ status: 'succeeded', cached: false });
});

test('a burst of requests is one build, and a paper cannot build without limit', async () => {
  const { project } = await paper();
  const ids = await Promise.all(
    Array.from({ length: 6 }, () => requestBuild(t.pool, owner.id, project)),
  );
  expect(new Set(ids).size).toBe(1);
  expect(
    (await t.pool.query('select count(*)::int as n from builds where project_id = $1', [project]))
      .rows[0].n,
  ).toBe(1);
  expect((await latestBuilds(t.pool, owner.id, project)).latest!.status).toBe('queued');
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect(await buildNext(t.pool, store, image)).toBe(false);

  await requestBuild(t.pool, owner.id, project, { perHour: 2 });
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect(await code(requestBuild(t.pool, owner.id, project, { perHour: 2 }))).toBe('conflict');
});

test('a broken paper reports where, and the last good PDF is still there', async () => {
  const { project, main } = await paper();
  const good = await build(project);
  await edit(main, (text) =>
    text.insert(text.toString().indexOf('Collaborative'), '\\nosuchmacro '),
  );
  const bad = await build(project);
  expect(bad).toMatchObject({ status: 'failed', hasPdf: false });
  expect(bad.diagnostics).toContainEqual({
    severity: 'error',
    file: 'main.tex',
    line: 21,
    message: 'Undefined control sequence.',
  });
  const { latest, lastGood } = await latestBuilds(t.pool, owner.id, project);
  expect(latest!.id).toBe(bad.id);
  expect(lastGood).toMatchObject({ id: good.id, hasPdf: true, stale: true });
  expect(await code(buildOutput(t.pool, store, owner.id, project, bad.id, 'pdf'))).toBe(
    'not_found',
  );
  // The same broken text fails from the cache too.
  expect(await build(project)).toMatchObject({ status: 'failed', cached: true });
});

test('a worker that dies gives its build back', async () => {
  const { project } = await paper();
  const id = await requestBuild(t.pool, owner.id, project);
  // A worker takes the build and then vanishes without finishing.
  const dying = new pg.Client({ connectionString: t.url });
  await dying.connect();
  await dying.query('begin');
  const taken = await dying.query(
    "select id from builds where status = 'queued' for update skip locked",
  );
  expect(taken.rows.map((r) => r.id)).toEqual([id]);
  // While it holds the build, nobody else starts it.
  expect(await buildNext(t.pool, store, image)).toBe(false);
  await dying.end();
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect((await latestBuilds(t.pool, owner.id, project)).latest).toMatchObject({
    id,
    status: 'succeeded',
  });
});

test('builds and their outputs are only for people on the paper', async () => {
  const { project } = await paper();
  const mine = await build(project);
  const { token } = await invite(t.pool, owner.id, project, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  // A viewer may read the PDF but not start builds.
  expect(
    (await buildOutput(t.pool, store, viewer.id, project, mine.id, 'pdf')).length,
  ).toBeGreaterThan(1000);
  expect(await code(requestBuild(t.pool, viewer.id, project))).toBe('permission_denied');

  for (const what of ['pdf', 'log', 'synctex'] as const)
    expect(await code(buildOutput(t.pool, store, outsider.id, project, mine.id, what)), what).toBe(
      'not_found',
    );
  expect(await code(latestBuilds(t.pool, outsider.id, project))).toBe('not_found');
  expect(await code(requestBuild(t.pool, outsider.id, project))).toBe('not_found');

  // A build cannot be reached through another paper, even by someone on both.
  const other = await paper();
  expect(await code(buildOutput(t.pool, store, owner.id, other.project, mine.id, 'pdf'))).toBe(
    'not_found',
  );
  const sneaky = 'pdf_digest from builds; drop table builds; --' as 'pdf';
  expect(await code(buildOutput(t.pool, store, owner.id, project, mine.id, sneaky))).toBe(
    'not_found',
  );
  // And one paper's cache never serves another: the same files in a new paper are built afresh.
  expect((await build(other.project)).cached).toBe(false);
});
