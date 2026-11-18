// Kept out of the package's main entry: only the migrate command and the tests run migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import type pg from 'pg';
import { authOptions } from './auth.ts';

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
