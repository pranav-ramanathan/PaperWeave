// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { requestBuild } from './builds.ts';
import { createProject } from './projects.ts';
import { testDb } from './testing.ts';

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

test('a build the editor asks for by itself over a limit is skipped, not an error', async () => {
  const e = await t.signIn('e@example.org');
  const ps = await papers(e.id, 4);
  const first = await Promise.all(
    ps.slice(0, 3).map((p) => requestBuild(t.pool, e.id, p, { automatic: true })),
  );
  expect(first.every((x) => typeof x === 'string')).toBe(true);
  // Counted like any other: the fourth is not queued, and says nothing.
  expect(await requestBuild(t.pool, e.id, ps[3], { automatic: true })).toBeNull();
  expect(
    (await t.pool.query('select count(*)::int as n from builds where project_id = $1', [ps[3]]))
      .rows[0].n,
  ).toBe(0);
  // A build the person presses for is told why.
  expect(await code(requestBuild(t.pool, e.id, ps[3]))).toBe('conflict');
});
