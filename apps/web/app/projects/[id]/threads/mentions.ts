import { AppError } from '@paperweave/server';
import { baseUrl, sendEmail } from '../../../../lib/server';

export const failed = (err: unknown) => {
  if (err instanceof AppError) return Response.json({ error: err.message }, { status: err.status });
  throw err;
};

/**
 * Tell the people a comment was addressed to. The email says who and where, and nothing of
 * what was written: the comment and the text it is about stay in the paper.
 */
export async function tellMentioned(
  to: string[],
  from: string,
  paper: string,
  projectId: string,
  fileId: string,
) {
  for (const address of to)
    await sendEmail(
      address,
      `${from} mentioned you in a comment`,
      `${from} mentioned you in a comment on the paper "${paper}".\n\nOpen it here:\n\n${baseUrl()}/projects/${projectId}/files/${fileId}#comments`,
    ).catch((err) =>
      // The comment is made whether or not the email goes out.
      console.error('mention email failed:', (err as Error).name),
    );
}
