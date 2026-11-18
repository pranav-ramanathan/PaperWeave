import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import { authOptions } from './auth.ts';

/** A pool, or a client inside a transaction: anything that runs a query. */
export type Db = Pick<pg.Pool, 'query'>;

export const connect = (url = process.env.DATABASE_URL) => {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString: url });
};

/** Run `fn` in one transaction: all of its writes happen, or none. */
export async function transaction<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS = join(import.meta.dirname, '../migrations');

/**
 * Bring the database up to date: the sign-in library's tables, then every migrations/*.sql file
 * not yet applied, in name order, each in its own transaction. Migrations only go forward: to undo
 * one, write the next. Returns the files applied.
 */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    // One migrator at a time, however many processes start together.
    await client.query('select pg_advisory_lock(7265001)');
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    // The sign-in library creates and upgrades its own tables; ours reference its users.
    await (await getMigrations(authOptions(pool, async () => {}))).runMigrations();
    const done = new Set(
      (await client.query('select name from schema_migrations')).rows.map((r) => r.name),
    );
    for (const name of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      if (done.has(name)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, name), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(name);
    }
  } finally {
    await client.query('select pg_advisory_unlock(7265001)').catch(() => {});
    client.release();
  }
  return applied;
}
