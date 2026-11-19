// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { listen, transaction } from './db.ts';
import { testDb } from './testing.ts';

let t: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());

const until = async (what: string, ok: () => boolean) => {
  const end = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('a connection lost in the middle of a transaction fails that work and nothing else', async () => {
  // The test runner fails a test in which an error goes unheard, as a process would end. That
  // is what this once did: nobody was listening to a connection that was out of the pool.
  const work = transaction(t.pool, async (db) => {
    const { rows } = await db.query('select pg_backend_pid() as pid');
    // Its connection is ended from outside while it is between two statements, as a restart of
    // the database would end it.
    await t.pool.query('select pg_terminate_backend($1)', [rows[0].pid]);
    await new Promise((r) => setTimeout(r, 100));
    await db.query('select 1');
    return 'finished';
  });
  await expect(work).rejects.toThrow(/connection/i);
  // The broken connection was thrown away: whoever comes next gets one that works.
  for (let i = 0; i < 12; i++) expect((await t.pool.query('select 1 as n')).rows[0].n).toBe(1);
  // And an ordinary failure still takes back what the transaction had written.
  await t.pool.query('create table kept (n int)');
  await expect(
    transaction(t.pool, async (db) => {
      await db.query('insert into kept values (1)');
      throw new Error('changed my mind');
    }),
  ).rejects.toThrow('changed my mind');
  expect((await t.pool.query('select count(*)::int as n from kept')).rows[0].n).toBe(0);
});

test('what is announced is heard again after the listening connection is lost', async () => {
  const heard: string[] = [];
  let again = 0;
  const stop = await listen(
    t.url,
    ['test_news'],
    (channel, payload) => void heard.push(`${channel}:${payload}`),
    () => void again++,
  );
  try {
    await t.pool.query("select pg_notify('test_news', 'before')");
    await until('the first announcement', () => heard.includes('test_news:before'));
    // Every other connection to this database is ended, the listening one among them.
    await t.pool.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid()`,
    );
    // It listens again by itself, and says so, so that its owner can look up what it missed.
    await until('listening again', () => again === 1);
    await t.pool.query("select pg_notify('test_news', 'after')");
    await until('an announcement after the loss', () => heard.includes('test_news:after'));
  } finally {
    await stop();
  }
  // Stopped: nothing more is heard, and it does not come back.
  await t.pool.query("select pg_notify('test_news', 'too late')");
  await new Promise((r) => setTimeout(r, 400));
  expect(heard).toEqual(['test_news:before', 'test_news:after']);
  expect(again).toBe(1);
});
