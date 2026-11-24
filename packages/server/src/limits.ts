// Counts and limits shared by the places that let a person make the service do more work or
// write more rows. Each limit has a default and a setting an operator can change.
import type { Db } from './db.ts';
import { AppError } from './errors.ts';

/** A positive whole number from the environment, or the default. */
export const envCount = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** What one person may send over the sync connection: bytes of edits, as a token bucket. */
export type EditBudgetConfig = {
  /** The most that can be spent at once, and what a person who has been quiet has. */
  burst: number;
  /** What is given back, a minute's worth at a time, as it is spent. */
  perMinute: number;
  /** What the smallest edit costs, so that many tiny edits are not free. */
  floor: number;
};

/** The settings of the edit budget: SYNC_EDIT_BURST_BYTES and SYNC_EDIT_BYTES_PER_MINUTE. */
export const editBudgetFromEnv = (): EditBudgetConfig => ({
  burst: envCount('SYNC_EDIT_BURST_BYTES', 20_000_000),
  perMinute: envCount('SYNC_EDIT_BYTES_PER_MINUTE', 2_000_000),
  floor: 512,
});

/**
 * A budget of bytes for each person: spent by edits, given back over time, never more than
 * `burst`. A person whose bucket is full again is forgotten, so what is held is only the people
 * who have spent something lately. `take` says whether `bytes` (at least `floor`) may be spent
 * now; if not, nothing is spent. `now` is for tests.
 */
export function editBudget({ burst, perMinute, floor }: EditBudgetConfig) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  let swept = 0;
  const refilled = (b: { tokens: number; at: number }, now: number) =>
    Math.min(burst, b.tokens + (Math.max(0, now - b.at) * perMinute) / 60_000);
  return {
    take(userId: string, bytes: number, now = Date.now()): boolean {
      // At most once a second: a sweep looks at everyone.
      if (now - swept >= 1000 || now < swept) {
        swept = now;
        for (const [id, b] of buckets) if (refilled(b, now) >= burst) buckets.delete(id);
      }
      const cost = Math.max(bytes, floor);
      const have = refilled(buckets.get(userId) ?? { tokens: burst, at: now }, now);
      const ok = have >= cost;
      const left = ok ? have - cost : have;
      if (left >= burst) buckets.delete(userId);
      else buckets.set(userId, { tokens: left, at: now });
      return ok;
    },
    /** How many people are held. */
    get size() {
      return buckets.size;
    },
  };
}

/** What one person may rewrite through the web app (restores, replaced files), in bytes an hour. */
export const WEB_EDIT_BYTES_PER_HOUR = 100_000_000;
/** What the smallest rewrite costs, even one that changes nothing. */
export const WEB_EDIT_FLOOR = 256 * 1024;

/**
 * What the smallest edit costs where edits are small and many (accepting a proposal, renaming a
 * label): a bulk accept of a few hundred must fit in one hour's budget, which 256 KB each would not.
 */
export const WEB_EDIT_SMALL_FLOOR = 4 * 1024;

/** `bytesPerHour` and `floor` default to the settings above; tests and small edits pass their own. */
export type RewriteOpts = { bytesPerHour?: number; floor?: number };
const REFUSED = 'You have changed too much in the last hour. Try again in a little while.';
const rewriteBudget = (opts: RewriteOpts) =>
  opts.bytesPerHour ?? envCount('WEB_EDIT_BYTES_PER_USER_HOUR', WEB_EDIT_BYTES_PER_HOUR);
const spentLastHour = async (db: Db, userId: string) =>
  Number(
    (
      await db.query(
        `select coalesce(sum(bytes), 0)::float8 as spent from web_edits
         where user_id = $1 and created_at > now() - interval '1 hour'`,
        [userId],
      )
    ).rows[0].spent,
  );

/**
 * An early check, before any file is read or stored: refuses if even the smallest rewrite no
 * longer fits in this person's hour. The exact charge is `chargeRewrite`, made later.
 */
export async function mayRewrite(db: Db, userId: string, opts: RewriteOpts = {}): Promise<void> {
  if ((await spentLastHour(db, userId)) + (opts.floor ?? WEB_EDIT_FLOOR) > rewriteBudget(opts))
    throw new AppError('conflict', REFUSED);
}

/**
 * Charge a rewrite of `appended` bytes of edits (at least the floor) to this person, over all
 * their papers. Called inside the transaction that made the edits, after them, so that a refusal
 * rolls them back. The person is locked for the rest of the transaction, so two rewrites at once
 * cannot both take the last of the budget. Rows a day old are removed.
 */
export async function chargeRewrite(
  db: Db,
  userId: string,
  projectId: string,
  appended: number,
  opts: RewriteOpts = {},
): Promise<void> {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`web_edits:${userId}`]);
  await db.query("delete from web_edits where created_at < now() - interval '1 day'");
  const cost = Math.max(appended, opts.floor ?? WEB_EDIT_FLOOR);
  if ((await spentLastHour(db, userId)) + cost > rewriteBudget(opts))
    throw new AppError('conflict', REFUSED);
  await db.query('insert into web_edits (user_id, project_id, bytes) values ($1, $2, $3)', [
    userId,
    projectId,
    cost,
  ]);
}

export const COMMENTS_PER_USER = 60; // on one paper, in ten minutes
export const COMMENTS_PER_PAPER = 2000; // in a day, from everyone

/**
 * Whether one more comment, reply or proposal may be written by this person on this paper. They
 * are counted from the rows themselves (deleted comments stay as rows, so deleting does not buy
 * room). Imported comments have no author and are not counted.
 */
export async function mayWrite(
  db: Db,
  userId: string,
  projectId: string,
  opts: { perUser?: number; perPaper?: number } = {},
): Promise<void> {
  const perUser = opts.perUser ?? envCount('COMMENTS_PER_USER', COMMENTS_PER_USER);
  const perPaper = opts.perPaper ?? envCount('COMMENTS_PER_PAPER', COMMENTS_PER_PAPER);
  const { rows } = await db.query(
    `select
       (select count(*) from thread_comments c join threads t on t.id = c.thread_id
         where t.project_id = $1 and c.author = $2 and c.created_at > now() - interval '10 minutes')
       + (select count(*) from proposals where project_id = $1 and author = $2
         and created_at > now() - interval '10 minutes') as mine,
       (select count(*) from thread_comments c join threads t on t.id = c.thread_id
         where t.project_id = $1 and c.author is not null and c.created_at > now() - interval '1 day')
       + (select count(*) from proposals where project_id = $1 and author is not null
         and created_at > now() - interval '1 day') as paper`,
    [projectId, userId],
  );
  if (Number(rows[0].mine) >= perUser)
    throw new AppError(
      'conflict',
      `You have written ${perUser} comments and proposals on this paper in the last ten minutes. Try again in a little while.`,
    );
  if (Number(rows[0].paper) >= perPaper)
    throw new AppError(
      'conflict',
      'This paper has had as many comments and proposals today as one paper may have. Try again tomorrow.',
    );
}
