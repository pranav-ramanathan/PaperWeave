import pg from 'pg';

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
