import pg from 'pg';

/** A pool, or a client inside a transaction: anything that runs a query. */
export type Db = Pick<pg.Pool, 'query'>;

export const connect = (url = process.env.DATABASE_URL) => {
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url });
  // A connection that is lost while nobody is using it (the database restarted, something
  // between cut it) is reported here. With nobody listening, that report is an error nobody
  // caught, and ends the process. The pool makes a new connection the next time one is needed.
  pool.on('error', (err) => console.error('a database connection was lost:', err.message));
  return pool;
};

/**
 * Listen for what is announced on some channels, for as long as the process runs.
 *
 * The connection that listens is one connection, and it can be lost: the database is
 * restarted, or something between cuts a connection that has been quiet. It is then made
 * again, and `again` is called: whatever was announced meanwhile was not heard, and the caller
 * has to find out for itself what it missed. Returns how to stop listening.
 */
export async function listen(
  url: string | undefined,
  channels: string[],
  heard: (channel: string, payload: string) => void | Promise<void>,
  again: () => void | Promise<void> = () => {},
): Promise<() => Promise<void>> {
  let current: pg.Client | null = null;
  let stopped = false;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const complain = (what: string) => (err: unknown) =>
    console.error(`${what}:`, (err as Error).message);

  const open = async () => {
    const client = new pg.Client({ connectionString: url });
    let listening = false;
    const lost = () => {
      // Before it was listening, the failure is whoever opened it's to deal with.
      if (!listening) return;
      listening = false;
      if (current === client) current = null;
      if (!stopped) reopen();
    };
    // Without these, a lost connection is an error nobody caught, and ends the process.
    client.on('error', lost);
    client.on('end', lost);
    try {
      await client.connect();
      // Channel names come from this code, never from a request.
      for (const channel of channels) await client.query(`listen "${channel}"`);
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    client.on('notification', (n) => {
      void Promise.resolve()
        .then(() => heard(n.channel, n.payload ?? ''))
        .catch(complain(`acting on what was announced on ${n.channel} failed`));
    });
    listening = true;
    current = client;
  };
  const reopen = () => {
    if (waiting || stopped) return;
    console.error('the connection that listens to the database was lost: connecting again');
    const attempt = async () => {
      waiting = undefined;
      if (stopped) return;
      try {
        await open();
      } catch {
        waiting = setTimeout(attempt, 1000);
        return;
      }
      await Promise.resolve()
        .then(again)
        .catch(complain('catching up after listening again failed'));
    };
    waiting = setTimeout(attempt, 250);
  };

  await open();
  return async () => {
    stopped = true;
    clearTimeout(waiting);
    const client = current;
    current = null;
    await client?.end().catch(() => {});
  };
}

/**
 * Be the only process doing a job on a database, for as long as this process runs. If another
 * is doing it, wait until it stops.
 *
 * The database gives the job's lock to one connection at a time and takes it back when that
 * connection ends, however it ends. If the connection holding it is lost (the database
 * restarted), the lock is asked for again; if another process got there first, `displaced` is
 * called, and this process must stop doing the job. Returns how to give the job up.
 */
export async function onlyOne(
  url: string | undefined,
  job: string,
  displaced: () => void,
  waiting: () => void = () => {},
): Promise<() => Promise<void>> {
  let stopped = false;
  let current: pg.Client | null = null;
  const take = async (wait: boolean): Promise<boolean> => {
    const client = new pg.Client({ connectionString: url });
    let held = false;
    const lost = () => {
      if (!held) return;
      held = false;
      if (current === client) current = null;
      if (!stopped) void retake();
    };
    client.on('error', lost);
    client.on('end', lost);
    try {
      await client.connect();
      const { rows } = await client.query('select pg_try_advisory_lock(hashtext($1)) as got', [
        job,
      ]);
      if (!rows[0].got) {
        if (!wait) {
          await client.end().catch(() => {});
          return false;
        }
        waiting();
        await client.query('select pg_advisory_lock(hashtext($1))', [job]);
      }
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    held = true;
    current = client;
    return true;
  };
  // After losing the connection: take the job back if nobody has it, and say so if someone has.
  const retake = async () => {
    for (;;) {
      if (stopped) return;
      try {
        if (!(await take(false))) displaced();
        return;
      } catch {
        // The database is still away. Nobody else can have taken the job from it either.
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  await take(true);
  return async () => {
    stopped = true;
    const client = current;
    current = null;
    await client?.end().catch(() => {});
  };
}

/**
 * Run `fn` in one transaction: all of its writes happen, or none.
 *
 * While a connection is out of the pool, its failing is its borrower's to hear: the pool only
 * listens to the ones it is holding. Unheard, a connection lost in the middle of a transaction
 * (the database restarted during a build, say) is an error nobody caught, and ends the process.
 * It is heard here. The query that was running fails as well, which is how `fn` finds out.
 */
export async function transaction<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let lost: Error | undefined;
  const hear = (err: Error) => void (lost = err);
  client.on('error', hear);
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    // On a connection that has gone there is nothing to take back, and the error that sent us
    // here is the one worth having.
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.removeListener('error', hear);
    // A connection that failed is thrown away, not handed to the next borrower.
    client.release(lost);
  }
}
