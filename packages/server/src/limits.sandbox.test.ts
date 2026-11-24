// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { transaction } from './db.ts';
import { chargeRewrite, mayRewrite, WEB_EDIT_FLOOR } from './limits.ts';
import { createProject } from './projects.ts';
import { testDb } from './testing.ts';

let t: Awaited<ReturnType<typeof testDb>>;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());

const charge = (userId: string, projectId: string, bytes: number, bytesPerHour: number) =>
  transaction(t.pool, (db) => chargeRewrite(db, userId, projectId, bytes, { bytesPerHour }));
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );
const spent = async (userId: string) =>
  Number(
    (
      await t.pool.query(
        'select coalesce(sum(bytes), 0)::float8 as n from web_edits where user_id = $1',
        [userId],
      )
    ).rows[0].n,
  );

test('charges add up for one person over all their papers, and a second person is unaffected', async () => {
  const a = await t.signIn('a@example.org');
  const b = await t.signIn('b@example.org');
  const one = await createProject(t.pool, a.id, 'One');
  const two = await createProject(t.pool, a.id, 'Two');
  const other = await createProject(t.pool, b.id, 'Other');
  const budget = 1_000_000;
  await charge(a.id, one.id, 350_000, budget);
  await charge(a.id, two.id, 350_000, budget);
  // 700 000 spent over two papers: 400 000 more does not fit, though no one paper is near it.
  expect(await code(charge(a.id, one.id, 400_000, budget))).toBe('conflict');
  expect(await spent(a.id)).toBe(700_000);
  await expect(charge(a.id, one.id, 400_000, budget)).rejects.toThrow(
    'You have changed too much in the last hour. Try again in a little while.',
  );
  // The smallest charge is the floor, however little was appended.
  await charge(a.id, one.id, 1, budget);
  expect(await spent(a.id)).toBe(700_000 + WEB_EDIT_FLOOR);
  // The other person has all of theirs.
  await charge(b.id, other.id, 700_000, budget);
  await mayRewrite(t.pool, b.id, { bytesPerHour: budget });
  expect(await spent(b.id)).toBe(700_000);
  // Not enough left for even the floor: refused early.
  expect(await code(mayRewrite(t.pool, a.id, { bytesPerHour: budget }))).toBe('conflict');
});

test('a charge 61 minutes old no longer counts', async () => {
  const a = await t.signIn('old@example.org');
  const p = await createProject(t.pool, a.id, 'Old');
  const budget = 1_000_000;
  await charge(a.id, p.id, 900_000, budget);
  expect(await code(charge(a.id, p.id, 900_000, budget))).toBe('conflict');
  await t.pool.query(
    "update web_edits set created_at = now() - interval '61 minutes' where user_id = $1",
    [a.id],
  );
  await mayRewrite(t.pool, a.id, { bytesPerHour: budget });
  await charge(a.id, p.id, 900_000, budget);
  // Only the new charge is held: the old one was not given back by being deleted, it just aged.
  expect(await spent(a.id)).toBe(1_800_000);
  // A day old, a row is removed by the next charge, whoever's it is.
  await t.pool.query(
    "update web_edits set created_at = now() - interval '25 hours' where user_id = $1 and bytes = 900000 and created_at < now() - interval '1 hour'",
    [a.id],
  );
  await charge(a.id, p.id, 1000, 2_000_000);
  expect(await spent(a.id)).toBe(900_000 + WEB_EDIT_FLOOR);
});

test('two charges at once cannot both take the last slot', async () => {
  const a = await t.signIn('race@example.org');
  const p = await createProject(t.pool, a.id, 'Race');
  const budget = 1_000_000;
  const results = await Promise.all(
    Array.from({ length: 4 }, () => code(charge(a.id, p.id, 600_000, budget))),
  );
  expect(results.filter((r) => r === 'ok')).toHaveLength(1);
  expect(results.filter((r) => r === 'conflict')).toHaveLength(3);
  expect(await spent(a.id)).toBe(600_000);
});
