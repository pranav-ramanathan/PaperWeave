// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { listen, onlyOne, transaction } from './db.ts';
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

test('only one process does a job at a time, and the next takes over when it stops', async () => {
  const said: string[] = [];
  const first = await onlyOne(t.url, 'the job', () => void said.push('first displaced'));
  // A second one waits, and says that it is waiting.
  let second: (() => Promise<void>) | undefined;
  const waitingForIt = onlyOne(
    t.url,
    'the job',
    () => void said.push('second displaced'),
    () => void said.push('second waiting'),
  ).then((stop) => void (second = stop));
  await until('the second to say it is waiting', () => said.includes('second waiting'));
  await new Promise((r) => setTimeout(r, 300));
  expect(second).toBeUndefined();
  // Another job is nobody's business: it is given at once.
  await (
    await onlyOne(t.url, 'another job', () => {})
  )();

  // The first stops: the second has the job.
  await first();
  await waitingForIt;
  expect(second).toBeDefined();

  // The holder loses its connection, as when the database is restarted. With nobody else
  // asking, it takes the job back and carries on.
  // Only holders in this test's own database. Without that it ended every such connection on
  // the server: among them other tests' while they set up their databases, which hold a lock
  // of this kind to do it, and failed now and then with "Connection terminated unexpectedly".
  const kill = () =>
    t.pool.query(
      `select pg_terminate_backend(l.pid) from pg_locks l
       where l.locktype = 'advisory' and l.granted and l.pid <> pg_backend_pid()
         and l.database = (select oid from pg_database where datname = current_database())`,
    );
  await kill();
  await new Promise((r) => setTimeout(r, 600));
  expect(said).toEqual(['second waiting']);
  // With someone else waiting for it, the one who lost it is told it has been displaced.
  let third: (() => Promise<void>) | undefined;
  const thirdWaiting = onlyOne(t.url, 'the job', () => void said.push('third displaced')).then(
    (stop) => void (third = stop),
  );
  await new Promise((r) => setTimeout(r, 300));
  expect(third).toBeUndefined();
  await kill();
  await thirdWaiting;
  await until('the second to learn it was displaced', () => said.includes('second displaced'));
  await second!();
  await third!();
});
