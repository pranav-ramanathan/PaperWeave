import { AppError, oneLine } from '@paperweave/server';
import { after } from 'next/server';
import { baseUrl, sendEmail } from '../../../../lib/server';

export const failed = (err: unknown) => {
  if (err instanceof AppError) return Response.json({ error: err.message }, { status: err.status });
  throw err;
};

/** Said to the person whose comment cost more mention emails than are sent in an hour. */
export const MENTION_LIMIT_NOTE =
  'Your comment is saved. No more emails will be sent for your mentions this hour.';

/**
 * Tell the people a comment was addressed to, all at once. The email says who and where, and
 * nothing of what was written: the comment and the text it is about stay in the paper. It
 * never fails: the comment is made whether or not the email goes out, and a failure is logged
 * with counts only, never the comment.
 */
async function tell(
  to: string[],
  from: string,
  paper: string,
  projectId: string,
  fileId: string,
  threadId: string,
) {
  // The paper's name is the author's to choose: on one line, it adds nothing to the message.
  const named = oneLine(paper);
  const results = await Promise.allSettled(
    to.map((address) =>
      sendEmail(
        address,
        `${from} mentioned you in a comment`,
        `${from} mentioned you in a comment on the paper "${named}".\n\nOpen it here:\n\n${baseUrl()}/projects/${projectId}/files/${fileId}?thread=${threadId}#comments`,
      ),
    ),
  );
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length)
    console.error(
      `mention email failed: ${failures.length} of ${to.length}, thread ${threadId}:`,
      [...new Set(failures.map((f) => (f.reason as Error)?.name))].join(', '),
    );
}

/**
 * Send the mention emails after the answer has gone: the person is not kept waiting for a mail
 * server, which may be slow or down.
 */
export function tellMentioned(
  to: string[],
  from: string,
  paper: string,
  projectId: string,
  fileId: string,
  threadId: string,
) {
  if (!to.length) return;
  after(() => tell(to, from, paper, projectId, fileId, threadId));
}
