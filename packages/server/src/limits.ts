// Counts and limits shared by the places that let a person make the service do more work or
// write more rows. Each limit has a default and a setting an operator can change.
import type { Db } from './db.ts';
import { AppError } from './errors.ts';

/** A positive whole number from the environment, or the default. */
export const envCount = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

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
