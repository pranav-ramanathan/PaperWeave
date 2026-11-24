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
