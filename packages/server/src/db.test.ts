import { afterEach, expect, test } from 'vitest';
import { connect } from './db.ts';

const url = 'postgres://u:p@localhost:5432/none';
const pools: ReturnType<typeof connect>[] = [];
const make = (env: Record<string, string | undefined>) => {
  const pool = connect(url, env);
  pools.push(pool);
  return pool;
};
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

test('the pool is as large, and keeps an idle connection as long, as the settings say', () => {
  const pool = make({ DATABASE_POOL_MAX: '3', DATABASE_POOL_IDLE_MS: '5000' });
  expect(pool.options.max).toBe(3);
  expect(pool.options.idleTimeoutMillis).toBe(5000);
});

test('without the settings, 10 connections and 10 seconds', () => {
  const pool = make({});
  expect(pool.options.max).toBe(10);
  expect(pool.options.idleTimeoutMillis).toBe(10_000);
  const empty = make({ DATABASE_POOL_MAX: '', DATABASE_POOL_IDLE_MS: ' ' });
  expect(empty.options.max).toBe(10);
});

test.each(['0', '-1', '2.5', 'ten', '1e3', '0x10'])('%s is refused, naming the setting', (bad) => {
  expect(() => connect(url, { DATABASE_POOL_MAX: bad })).toThrow(
    new RegExp(`DATABASE_POOL_MAX must be a positive whole number, not "${bad}"`),
  );
  expect(() => connect(url, { DATABASE_POOL_IDLE_MS: bad })).toThrow(/DATABASE_POOL_IDLE_MS/);
});

test('a statement gets 30 seconds, a connection 10, and a quiet line is noticed', () => {
  const pool = make({});
  expect(pool.options.query_timeout).toBe(30_000);
  expect(pool.options.connectionTimeoutMillis).toBe(10_000);
  expect(pool.options.keepAlive).toBe(true);
  // The migrator may wait as long as another one runs: it has no limit.
  expect(connect(url, {}, 0).options.query_timeout).toBe(0);
});
