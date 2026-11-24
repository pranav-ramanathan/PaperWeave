// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { lineMap, requestBuild } from './builds.ts';
import { importZip, listFiles } from './import.ts';
import { createProject } from './projects.ts';
import { saveRevision } from './revisions.ts';
import { editFile } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';

let t: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );
const papers = async (userId: string, n: number) =>
  Promise.all(Array.from({ length: n }, (_, i) => createProject(t.pool, userId, `P${i}`))).then(
    (ps) => ps.map((p) => p.id),
  );

test('one person may have three builds waiting over all their papers; someone else may still build', async () => {
  const a = await t.signIn('a@example.org');
  const b = await t.signIn('b@example.org');
  const [p1, p2, p3, p4] = await papers(a.id, 4);
  const [q] = await papers(b.id, 1);
  for (const p of [p1, p2, p3]) await requestBuild(t.pool, a.id, p);
  // The same build asked for again is that build, not another.
  expect(await code(requestBuild(t.pool, a.id, p1))).toBe('ok');
  await expect(requestBuild(t.pool, a.id, p4)).rejects.toMatchObject({
    code: 'conflict',
    message: 'You have 3 builds waiting already. Wait for one to finish.',
  });
  expect(await code(requestBuild(t.pool, b.id, q))).toBe('ok');
  // One done, and there is room again.
  await t.pool.query(
    "update builds set status = 'succeeded', finished_at = now() where project_id = $1",
    [p1],
  );
  expect(await code(requestBuild(t.pool, a.id, p4))).toBe('ok');
});

test('requests made at the same moment cannot pass the count together', async () => {
  const c = await t.signIn('c@example.org');
  const ps = await papers(c.id, 8);
  const answers = await Promise.all(ps.map((p) => code(requestBuild(t.pool, c.id, p))));
  expect(answers.filter((x) => x === 'ok')).toHaveLength(3);
  expect(
    (await t.pool.query('select count(*)::int as n from builds where requested_by = $1', [c.id]))
      .rows[0].n,
  ).toBe(3);
});

test('a person may ask for only so many builds an hour over all their papers', async () => {
  const d = await t.signIn('d@example.org');
  const [p1, p2] = await papers(d.id, 2);
  const done = () =>
    t.pool.query(
      "update builds set status = 'succeeded', finished_at = now() where requested_by = $1",
      [d.id],
    );
  const opts = { perUserHour: 3, perHour: 100 };
  for (const p of [p1, p2, p1]) {
    await requestBuild(t.pool, d.id, p, opts);
    await done();
  }
  await expect(requestBuild(t.pool, d.id, p2, opts)).rejects.toMatchObject({
    code: 'conflict',
    message: expect.stringContaining('3 builds in the last hour'),
  });
  // Builds older than an hour are not counted.
  await t.pool.query(
    "update builds set created_at = now() - interval '2 hours' where requested_by = $1",
    [d.id],
  );
  expect(await code(requestBuild(t.pool, d.id, p2, opts))).toBe('ok');
});

test('a build the editor asks for by itself over a limit is skipped with a reason, not an error', async () => {
  const e = await t.signIn('e@example.org');
  const ps = await papers(e.id, 4);
  const first = await Promise.all(
    ps.slice(0, 3).map((p) => requestBuild(t.pool, e.id, p, { automatic: true })),
  );
  expect(first.every((x) => typeof x === 'string')).toBe(true);
  // Counted like any other: the fourth is not queued, and says why.
  expect(await requestBuild(t.pool, e.id, ps[3], { automatic: true })).toEqual({
    paused: expect.stringContaining('3 builds waiting'),
  });
  expect(
    (await t.pool.query('select count(*)::int as n from builds where project_id = $1', [ps[3]]))
      .rows[0].n,
  ).toBe(0);
  // A build the person presses for is told why.
  expect(await code(requestBuild(t.pool, e.id, ps[3]))).toBe('conflict');
});

const finish = (userId: string) =>
  t.pool.query(
    "update builds set status = 'succeeded', finished_at = now() where requested_by = $1",
    [userId],
  );

test('automatic builds stop short of the paper limit, and a pressed build still gets in', async () => {
  const f = await t.signIn('f@example.org');
  const [p] = await papers(f.id, 1);
  const opts = { perHour: 5, reserve: 2 };
  for (let i = 0; i < 3; i++) {
    expect(await requestBuild(t.pool, f.id, p, { ...opts, automatic: true })).toEqual(
      expect.any(String),
    );
    await finish(f.id);
  }
  const refused = await requestBuild(t.pool, f.id, p, { ...opts, automatic: true });
  expect(refused).toEqual({ paused: expect.stringContaining('built 3 times this hour') });
  // The people's share: pressed builds go to the full limit, and past it they are refused.
  for (let i = 0; i < 2; i++) {
    expect(await code(requestBuild(t.pool, f.id, p, opts))).toBe('ok');
    await finish(f.id);
  }
  expect(await code(requestBuild(t.pool, f.id, p, opts))).toBe('conflict');
});

test('automatic builds stop short of the per-person limit too', async () => {
  const g = await t.signIn('g@example.org');
  const [p1, p2] = await papers(g.id, 2);
  const opts = { perUserHour: 5, perHour: 100, reserve: 2 };
  for (const p of [p1, p2, p1]) {
    expect(await requestBuild(t.pool, g.id, p, { ...opts, automatic: true })).toEqual(
      expect.any(String),
    );
    await finish(g.id);
  }
  expect(await requestBuild(t.pool, g.id, p2, { ...opts, automatic: true })).toEqual({
    paused: expect.stringContaining('3 builds this hour'),
  });
  expect(await code(requestBuild(t.pool, g.id, p2, opts))).toBe('ok');
});

test('automatic builds are spaced 30 seconds apart once half the hour is used', async () => {
  const h = await t.signIn('h@example.org');
  const [p] = await papers(h.id, 1);
  const opts = { perHour: 6, reserve: 0, automatic: true as const };
  for (let i = 0; i < 3; i++) {
    expect(await requestBuild(t.pool, h.id, p, opts)).toEqual(expect.any(String));
    await finish(h.id);
  }
  // Half the hour is used and the last build was just now.
  expect(await requestBuild(t.pool, h.id, p, opts)).toEqual({
    paused: expect.stringContaining('30 seconds apart'),
  });
  // A build a person presses for is not spaced.
  expect(await code(requestBuild(t.pool, h.id, p, { perHour: 6, reserve: 0 }))).toBe('ok');
  await finish(h.id);
  await t.pool.query(
    "update builds set created_at = now() - interval '1 minute' where requested_by = $1",
    [h.id],
  );
  expect(await requestBuild(t.pool, h.id, p, opts)).toEqual(expect.any(String));
});

test('the line map from a saved revision to now is exact for a line between far-apart changes', async () => {
  const store = blobStore(TEST_ENV);
  const u = await t.signIn('linemap@example.org');
  const long =
    Array.from({ length: 2600 }, (_, i) => `Row ${i} keeps its words.`).join('\n') + '\n';
  const zip = await writeZip([
    {
      path: 'main.tex',
      bytes: Buffer.from('\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n'),
    },
    { path: 'long.tex', bytes: Buffer.from(long) },
  ]);
  const [project] = await importZip(t.pool, store, u.id, zip, 'Lines');
  const fileId = (await listFiles(t.pool, u.id, project.id)).find((f) => f.path === 'long.tex')!.id;
  const rev = await saveRevision(t.pool, store, u.id, project.id, 'Built');
  // A line added near the top and one reworded near the bottom, over 2,000 lines apart.
  await editFile(t.pool, store, fileId, u.id, (tx) => {
    const top = tx.toString().indexOf('Row 5 keeps');
    tx.insert(top, 'Added above row 5.\n');
    const bottom = tx.toString().indexOf('Row 2595 keeps');
    tx.delete(bottom, 'Row 2595 keeps'.length);
    tx.insert(bottom, 'Row 2595 lost');
  });
  const map = await lineMap(t.pool, store, project.id, rev.id, fileId);
  if (map === 'gone') throw new Error('the file is gone');
  // Row 1300 is line 1301, and one line was added above it.
  expect(map.toNow(1301)).toEqual({ line: 1302, moved: false });
  expect(map.toBuilt(1302)).toEqual({ line: 1301, moved: false });
});
