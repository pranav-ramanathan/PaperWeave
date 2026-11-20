// Threads: comments about a stretch of a file's text. The stretch is held as Yjs positions, so
// it follows the text as it is edited. When all of it is deleted the thread is kept, detached,
// with the words it was about.
import type pg from 'pg';
import * as Y from 'yjs';
import { authorize } from './authz.ts';
import { type BlobStore, sha256 } from './blobs.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { docsOf, loadUpdates, TEXT } from './sync.ts';

export type ThreadComment = {
  id: string;
  author: string | null;
  body: string;
  /** Email addresses of the people it was addressed to. */
  mentions: string[];
  createdAt: string;
};
export type Thread = {
  id: string;
  fileId: string;
  path: string;
  /** The stretch as two encoded Yjs positions, base64: an open editor finds it in its own copy. */
  from: string;
  to: string;
  /**
   * `attached`: the text is as it was. `changed`: it has been edited since. `detached`: all of
   * it has been deleted.
   */
  state: 'attached' | 'changed' | 'detached';
  /** What the thread was started on, and what stood around it then. */
  excerpt: string;
  before: string;
  after: string;
  /** The stretch as it reads now. Empty when detached. */
  now: string;
  status: 'open' | 'resolved';
  startedBy: string | null;
  createdAt: string;
  comments: ThreadComment[];
};

/** How many mention emails one person's comments may cause in an hour, over all their papers. */
export const MENTION_EMAILS_PER_HOUR = 60;

const EXCERPT = 500;
const CONTEXT = 80;
const bad = (why: string) => new AppError('invalid_input', why);

/** A file's text as the log has it. */
async function textOf(
  pool: pg.Pool,
  store: BlobStore,
  fileId: string,
  logs?: Map<string, Uint8Array[]>,
) {
  const doc = new Y.Doc();
  // A paper's listing reads every log in one statement; a file with none opens as it always did.
  const logged = logs?.get(fileId);
  for (const update of logged?.length ? logged : await loadUpdates(pool, store, fileId))
    Y.applyUpdate(doc, update);
  return { doc, text: doc.getText(TEXT) };
}
/** Where an encoded position is in a document now, or -1 if the document does not know it. */
function locate(doc: Y.Doc, text: Y.Text, encoded: Uint8Array) {
  try {
    const at = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(encoded), doc);
    return at?.type === text ? at.index : -1;
  } catch {
    return -1;
  }
}
function body(input: unknown) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) throw bad('Write something first.');
  if (text.length > 5000) throw bad('That comment is too long.');
  return text;
}
/** The members of the paper among the IDs given: a comment can only be addressed to them. */
async function members(db: Db, projectId: string, input: unknown): Promise<string[]> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 20 || input.some((m) => typeof m !== 'string'))
    throw bad('Choose who to mention from the people on the paper.');
  const { rows } = await db.query(
    'select user_id from project_members where project_id = $1 and user_id = any($2::uuid[])',
    [projectId, input.map((m) => id(m))],
  );
  if (rows.length !== new Set(input).size)
    throw bad('Choose who to mention from the people on the paper.');
  return rows.map((r) => r.user_id);
}

/**
 * Start a thread on a stretch of a file, with its first comment. `from` and `to` are encoded Yjs
 * relative positions made by the editor. They must be known to the saved text: a stretch typed
 * a moment ago and not saved yet cannot be commented on until it is.
 */
export async function startThread(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId: string,
  input: { from: unknown; to: unknown; body: unknown; mentions?: unknown },
  perHour = MENTION_EMAILS_PER_HOUR,
): Promise<{ id: string; mentioned: string[]; limited?: true }> {
  await authorize(pool, userId, id(projectId), 'comment.write');
  const file = (
    await pool.query('select 1 from files where id = $1 and project_id = $2 and eol is not null', [
      id(fileId),
      projectId,
    ])
  ).rows[0];
  if (!file) throw new AppError('not_found', 'No such file.');
  const said = body(input.body);
  const place = (v: unknown) => {
    if (!(v instanceof Uint8Array) || !v.length || v.length > 100)
      throw bad('That place in the text cannot be commented on.');
    return v;
  };
  const [a, b] = [place(input.from), place(input.to)];
  const { doc, text } = await textOf(pool, store, fileId);
  const [from, to] = [locate(doc, text, a), locate(doc, text, b)];
  if (from < 0 || to < 0)
    throw new AppError('conflict', 'That text has not been saved yet. Try again in a moment.');
  if (to <= from) throw bad('Select the text the comment is about.');
  const all = text.toString();
  const stretch = all.slice(from, to);
  const mentions = await members(pool, projectId, input.mentions);
  const made = (
    await pool.query(
      `insert into threads (project_id, file_id, anchor_from, anchor_to, excerpt, context_before,
         context_after, fingerprint, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        projectId,
        fileId,
        Buffer.from(a),
        Buffer.from(b),
        stretch.slice(0, EXCERPT),
        all.slice(Math.max(0, from - CONTEXT), from),
        all.slice(to, to + CONTEXT),
        sha256(Buffer.from(stretch)),
        userId,
      ],
    )
  ).rows[0];
  await pool.query(
    'insert into thread_comments (thread_id, author, body, mentions) values ($1, $2, $3, $4)',
    [made.id, userId, said, mentions],
  );
  return { id: made.id, ...(await toEmail(pool, mentions, userId, perHour)) };
}

/**
 * The addresses to email about a comment: the people it was addressed to, its author left out,
 * and no more than the hour's limit allows. Counted from the comments themselves: each person
 * a comment is addressed to (other than its author) is one email. A comment is saved whether
 * or not all its emails are sent; `limited` is set when some were left out. The comment just
 * saved is already in the count, so it is taken off.
 */
async function toEmail(db: Db, users: string[], author: string, perHour: number) {
  const { rows } = await db.query('select email from "user" where id = any($1) and id <> $2', [
    users,
    author,
  ]);
  const addresses: string[] = rows.map((r) => r.email);
  if (!addresses.length) return { mentioned: addresses };
  const earlier = (
    await db.query(
      `select coalesce(sum(cardinality(array_remove(mentions, author))), 0)::int as n
       from thread_comments
       where author = $1 and created_at > now() - interval '1 hour'`,
      [author],
    )
  ).rows[0].n as number;
  const room = Math.max(0, perHour - (earlier - addresses.length));
  return addresses.length <= room
    ? { mentioned: addresses }
    : { mentioned: addresses.slice(0, room), limited: true as const };
}

/** Add a comment to a thread. Returns the addresses of the people it mentions. */
export async function reply(
  db: Db,
  userId: string,
  projectId: string,
  threadId: string,
  input: { body: unknown; mentions?: unknown },
  perHour = MENTION_EMAILS_PER_HOUR,
): Promise<{ fileId: string; mentioned: string[]; limited?: true }> {
  await authorize(db, userId, id(projectId), 'comment.write');
  const thread = (
    await db.query('select file_id from threads where id = $1 and project_id = $2', [
      id(threadId),
      projectId,
    ])
  ).rows[0];
  if (!thread) throw new AppError('not_found', 'No such thread.');
  const said = body(input.body);
  const mentions = await members(db, projectId, input.mentions);
  await db.query(
    'insert into thread_comments (thread_id, author, body, mentions) values ($1, $2, $3, $4)',
    [threadId, userId, said, mentions],
  );
  return { fileId: thread.file_id, ...(await toEmail(db, mentions, userId, perHour)) };
}

/** Mark a thread as dealt with, or open it again. */
export async function setThreadStatus(
  db: Db,
  userId: string,
  projectId: string,
  threadId: string,
  status: unknown,
): Promise<void> {
  await authorize(db, userId, id(projectId), 'comment.write');
  if (status !== 'open' && status !== 'resolved') throw bad('A thread is open or resolved.');
  const done = await db.query(
    `update threads set status = $3, resolved_by = case when $3 = 'resolved' then $4::uuid end,
       resolved_at = case when $3 = 'resolved' then now() end
     where id = $1 and project_id = $2`,
    [id(threadId), projectId, status, userId],
  );
  if (!done.rowCount) throw new AppError('not_found', 'No such thread.');
}

/**
 * Attach a detached thread to the same words where they stand now. Only when there is no doubt
 * which words are meant: they are in the file exactly once.
 */
export async function reattachThread(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  threadId: string,
): Promise<void> {
  await authorize(pool, userId, id(projectId), 'comment.write');
  const thread = (
    await pool.query(
      `select t.file_id, t.anchor_from, t.anchor_to, t.excerpt, t.fingerprint from threads t
       join files f on f.id = t.file_id where t.id = $1 and t.project_id = $2`,
      [id(threadId), projectId],
    )
  ).rows[0];
  if (!thread) throw new AppError('not_found', 'No such thread.');
  const { doc, text } = await textOf(pool, store, thread.file_id);
  const [was, end] = [locate(doc, text, thread.anchor_from), locate(doc, text, thread.anchor_to)];
  if (was >= 0 && end > was) throw bad('That thread is still attached to its text.');
  // Only the first part of a long stretch was kept, which is not enough to find it by.
  if (sha256(Buffer.from(thread.excerpt)) !== thread.fingerprint)
    throw bad('That stretch was too long to find again. Start a new thread on the text.');
  const all = text.toString();
  const at = all.indexOf(thread.excerpt);
  if (at < 0) throw new AppError('conflict', 'Those words are not in the file now.');
  if (all.indexOf(thread.excerpt, at + 1) >= 0)
    throw new AppError(
      'conflict',
      'Those words are in the file more than once. Start a new thread on the ones you mean.',
    );
  const to = at + thread.excerpt.length;
  const place = (index: number, side: number) =>
    Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, side)));
  await pool.query(
    `update threads set anchor_from = $2, anchor_to = $3, context_before = $4, context_after = $5
     where id = $1`,
    [
      threadId,
      place(at, 0),
      place(to, -1),
      all.slice(Math.max(0, at - CONTEXT), at),
      all.slice(to, to + CONTEXT),
    ],
  );
}

/** The threads of a paper, or of one of its files, oldest first, each with where it stands now. */
export async function listThreads(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId?: string,
): Promise<Thread[]> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const { rows } = await pool.query(
    `select t.id, t.file_id, f.path, t.anchor_from, t.anchor_to, t.excerpt, t.context_before,
            t.context_after, t.fingerprint, t.status, t.created_at,
            coalesce(u.email, t.imported_author) as email
     from threads t join files f on f.id = t.file_id left join "user" u on u.id = t.created_by
     where t.project_id = $1 and ($2::uuid is null or t.file_id = $2)
     order by t.created_at, t.id`,
    [projectId, fileId === undefined ? null : id(fileId)],
  );
  const comments = (
    await pool.query(
      `select c.id, c.thread_id, c.body, c.created_at,
              coalesce(u.email, c.imported_author) as email,
              array(select m.email from "user" m where m.id = any(c.mentions) order by m.email) as mentions
       from thread_comments c left join "user" u on u.id = c.author
       where c.thread_id = any($1) order by c.created_at, c.id`,
      [rows.map((r) => r.id)],
    )
  ).rows;
  // For the whole paper, every log is read in one statement; for one file, only its own.
  const logs = rows.length && fileId === undefined ? await docsOf(pool, projectId) : undefined;
  const texts = new Map<string, Awaited<ReturnType<typeof textOf>>>();
  const out: Thread[] = [];
  for (const r of rows) {
    if (!texts.has(r.file_id)) texts.set(r.file_id, await textOf(pool, store, r.file_id, logs));
    const { doc, text } = texts.get(r.file_id)!;
    const [from, to] = [locate(doc, text, r.anchor_from), locate(doc, text, r.anchor_to)];
    const now = from >= 0 && to > from ? text.toString().slice(from, to) : '';
    out.push({
      id: r.id,
      fileId: r.file_id,
      path: r.path,
      from: Buffer.from(r.anchor_from).toString('base64'),
      to: Buffer.from(r.anchor_to).toString('base64'),
      state: !now
        ? 'detached'
        : sha256(Buffer.from(now)) === r.fingerprint
          ? 'attached'
          : 'changed',
      excerpt: r.excerpt,
      before: r.context_before,
      after: r.context_after,
      now: now.slice(0, EXCERPT),
      status: r.status,
      startedBy: r.email,
      createdAt: r.created_at.toISOString(),
      comments: comments
        .filter((c) => c.thread_id === r.id)
        .map((c) => ({
          id: c.id,
          author: c.email,
          body: c.body,
          mentions: c.mentions,
          createdAt: c.created_at.toISOString(),
        })),
    });
  }
  return out;
}
