// Proposed edits: "replace this stretch with that". Anyone who may comment can propose one;
// only someone who may edit can accept it, and only then does it touch the paper. Accepting
// goes through the command path, so it lands exactly as proposed or not at all.
import type pg from 'pg';
import * as Y from 'yjs';
import { authorize, can } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { runCommand } from './commands.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { loadUpdates, TEXT } from './sync.ts';

export type Proposal = {
  id: string;
  fileId: string;
  path: string;
  /** The stretch as two encoded Yjs positions, base64. */
  from: string;
  to: string;
  /** What the stretch said when this was proposed (or, once accepted, what it was put back to). */
  expected: string;
  replacement: string;
  reason: string;
  status: 'open' | 'accepted' | 'rejected' | 'dismissed';
  /**
   * Open: the stretch no longer says what it said, so the proposal cannot be accepted as it
   * is. Accepted: the replacement has been changed since, so the accept cannot be undone.
   */
  stale: boolean;
  /** The stretch as it reads now. */
  now: string;
  author: string | null;
  /** Whether the person asking wrote it. */
  mine: boolean;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
};

const MAX = 20_000;
const bad = (why: string) => new AppError('invalid_input', why);

async function textOf(pool: pg.Pool, store: BlobStore, fileId: string) {
  const doc = new Y.Doc();
  for (const update of await loadUpdates(pool, store, fileId)) Y.applyUpdate(doc, update);
  return { doc, text: doc.getText(TEXT) };
}
function locate(doc: Y.Doc, text: Y.Text, encoded: Uint8Array) {
  try {
    const at = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(encoded), doc);
    return at?.type === text ? at.index : -1;
  } catch {
    return -1;
  }
}
/** The text of a replacement: LF line ends only, and not too long. */
function replacementOf(input: unknown) {
  if (typeof input !== 'string') throw bad('Say what the text should be replaced with.');
  if (input.length > MAX) throw bad('That replacement is too long.');
  if (input.includes('\r')) throw bad('A replacement cannot hold a carriage return.');
  return input;
}
function reasonOf(input: unknown) {
  const reason = typeof input === 'string' ? input.trim() : '';
  if (reason.length > 1000) throw bad('That reason is too long.');
  return reason;
}
/** An open or accepted proposal of this paper, or an error. */
async function find(db: Db, projectId: string, proposalId: string) {
  const found = (
    await db.query(
      `select p.id, p.file_id, p.author, p.anchor_from, p.anchor_to, p.expected, p.replacement,
              p.status, p.command_key
       from proposals p join files f on f.id = p.file_id
       where p.id = $1 and p.project_id = $2`,
      [id(proposalId), projectId],
    )
  ).rows[0];
  if (!found) throw new AppError('not_found', 'No such proposal.');
  return found;
}
const notOpen = () => new AppError('conflict', 'That proposal has already been decided.');

/**
 * Propose replacing a stretch of a file. `from` and `to` are encoded Yjs relative positions
 * made by the editor; an empty stretch proposes an insertion. Nothing is written to the paper.
 */
export async function propose(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId: string,
  input: { from: unknown; to: unknown; replacement: unknown; reason?: unknown },
): Promise<string> {
  await authorize(pool, userId, id(projectId), 'proposal.create');
  const file = (
    await pool.query('select 1 from files where id = $1 and project_id = $2 and eol is not null', [
      id(fileId),
      projectId,
    ])
  ).rows[0];
  if (!file) throw new AppError('not_found', 'No such file.');
  const place = (v: unknown) => {
    if (!(v instanceof Uint8Array) || !v.length || v.length > 100)
      throw bad('That place in the text cannot be changed.');
    return v;
  };
  const [a, b] = [place(input.from), place(input.to)];
  const replacement = replacementOf(input.replacement);
  const reason = reasonOf(input.reason);
  const { doc, text } = await textOf(pool, store, fileId);
  const [from, to] = [locate(doc, text, a), locate(doc, text, b)];
  if (from < 0 || to < 0)
    throw new AppError('conflict', 'That text has not been saved yet. Try again in a moment.');
  if (to < from) throw bad('Select the text to change.');
  const expected = text.toString().slice(from, to);
  if (expected.length > MAX) throw bad('That is too much text for one proposal.');
  if (expected === replacement) throw bad('That would change nothing.');
  const made = await pool.query(
    `insert into proposals (project_id, file_id, author, anchor_from, anchor_to, expected,
       replacement, reason, base_revision)
     values ($1, $2, $3, $4, $5, $6, $7, $8,
       (select id from revisions where project_id = $1 order by number desc limit 1))
     returning id`,
    [projectId, fileId, userId, Buffer.from(a), Buffer.from(b), expected, replacement, reason],
  );
  return made.rows[0].id;
}

/**
 * Change what an open proposal proposes. Its author may, and so may anyone who could accept it.
 * If the text has changed since it was made, it is now a proposal about the text as it reads.
 */
export async function reviseProposal(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  proposalId: string,
  input: { replacement: unknown; reason?: unknown },
): Promise<void> {
  const role = await authorize(pool, userId, id(projectId), 'proposal.create');
  const p = await find(pool, projectId, proposalId);
  if (p.author !== userId && !can(role, 'proposal.decide'))
    throw new AppError('permission_denied', 'Only its author or an editor can change a proposal.');
  if (p.status !== 'open') throw notOpen();
  const replacement = replacementOf(input.replacement);
  const { doc, text } = await textOf(pool, store, p.file_id);
  const [from, to] = [locate(doc, text, p.anchor_from), locate(doc, text, p.anchor_to)];
  if (from < 0 || to < from)
    throw new AppError('conflict', 'The text this was about is gone. Make a new proposal.');
  const expected = text.toString().slice(from, to);
  if (expected === replacement) throw bad('That would change nothing.');
  const done = await pool.query(
    `update proposals set replacement = $2, reason = $3, expected = $4
     where id = $1 and status = 'open'`,
    [p.id, replacement, reasonOf(input.reason), expected],
  );
  if (!done.rowCount) throw notOpen();
}

/**
 * Accept a proposal: make its edit, as the person accepting. If the text no longer says what the
 * proposal expected, nothing is done and the answer is `conflict`.
 */
export async function acceptProposal(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  proposalId: string,
): Promise<void> {
  await authorize(pool, userId, id(projectId), 'proposal.decide');
  const p = await find(pool, projectId, proposalId);
  // Asked twice (a retry whose answer was lost): the first time did it.
  if (p.status === 'accepted') return;
  if (p.status !== 'open') throw notOpen();
  const done = await runCommand(
    pool,
    store,
    userId,
    p.file_id,
    {
      key: p.command_key,
      from: new Uint8Array(p.anchor_from),
      to: new Uint8Array(p.anchor_to),
      expected: p.expected,
      replacement: p.replacement,
    },
    {
      // In the same transaction as the edit: both happen, or neither. From here on the
      // proposal's stretch is the replacement where it stands, which is what an undo needs.
      within: async (db, placed) => {
        const marked = await db.query(
          `update proposals set status = 'accepted', decided_by = $2, decided_at = now(),
             anchor_from = $3, anchor_to = $4, command_key = gen_random_uuid()
           where id = $1 and status = 'open'`,
          [p.id, userId, Buffer.from(placed.from), Buffer.from(placed.to)],
        );
        if (!marked.rowCount) throw notOpen();
      },
    },
  );
  if (done.result === 'conflict')
    throw new AppError(
      'conflict',
      'The text has changed since this was proposed. Look at it again before accepting.',
    );
}

/**
 * Undo an accept: put back what the proposal replaced, and open the proposal again. Only while
 * the replacement still stands as it was accepted.
 */
export async function undoAccept(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  proposalId: string,
): Promise<void> {
  await authorize(pool, userId, id(projectId), 'proposal.decide');
  const p = await find(pool, projectId, proposalId);
  if (p.status === 'open') return;
  if (p.status !== 'accepted') throw new AppError('conflict', 'That proposal was not accepted.');
  const done = await runCommand(
    pool,
    store,
    userId,
    p.file_id,
    {
      key: p.command_key,
      from: new Uint8Array(p.anchor_from),
      to: new Uint8Array(p.anchor_to),
      expected: p.replacement,
      replacement: p.expected,
    },
    {
      within: async (db, placed) => {
        const marked = await db.query(
          `update proposals set status = 'open', decided_by = null, decided_at = null,
             anchor_from = $2, anchor_to = $3, command_key = gen_random_uuid()
           where id = $1 and status = 'accepted'`,
          [p.id, Buffer.from(placed.from), Buffer.from(placed.to)],
        );
        if (!marked.rowCount) throw new AppError('conflict', 'That proposal was not accepted.');
      },
    },
  );
  if (done.result === 'conflict')
    throw new AppError(
      'conflict',
      'The text has been changed since this was accepted, so it cannot be put back as it was.',
    );
}

/**
 * Turn an open proposal down (someone who may edit), or withdraw it (its author). The paper is
 * not touched.
 */
export async function closeProposal(
  db: Db,
  userId: string,
  projectId: string,
  proposalId: string,
  how: unknown,
): Promise<void> {
  if (how !== 'rejected' && how !== 'dismissed') throw bad('Reject a proposal or withdraw it.');
  await authorize(
    db,
    userId,
    id(projectId),
    how === 'rejected' ? 'proposal.decide' : 'proposal.create',
  );
  const p = await find(db, projectId, proposalId);
  if (how === 'dismissed' && p.author !== userId)
    throw new AppError('permission_denied', 'Only its author can withdraw a proposal.');
  const done = await db.query(
    `update proposals set status = $2, decided_by = $3, decided_at = now()
     where id = $1 and status = 'open'`,
    [p.id, how, userId],
  );
  if (!done.rowCount) throw notOpen();
}

/** The proposals of a paper, or of one of its files, oldest first, with where each stands. */
export async function listProposals(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId?: string,
): Promise<Proposal[]> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const { rows } = await pool.query(
    `select p.id, p.file_id, f.path, p.anchor_from, p.anchor_to, p.expected, p.replacement,
            p.reason, p.status, p.author, p.created_at, p.decided_at, a.email as author_email,
            d.email as decider_email
     from proposals p join files f on f.id = p.file_id
     left join "user" a on a.id = p.author left join "user" d on d.id = p.decided_by
     where p.project_id = $1 and ($2::uuid is null or p.file_id = $2)
     order by p.created_at, p.id`,
    [projectId, fileId === undefined ? null : id(fileId)],
  );
  const texts = new Map<string, Awaited<ReturnType<typeof textOf>>>();
  const out: Proposal[] = [];
  for (const r of rows) {
    if (!texts.has(r.file_id)) texts.set(r.file_id, await textOf(pool, store, r.file_id));
    const { doc, text } = texts.get(r.file_id)!;
    const [from, to] = [locate(doc, text, r.anchor_from), locate(doc, text, r.anchor_to)];
    const now = from >= 0 && to >= from ? text.toString().slice(from, to) : '';
    const known = from >= 0 && to >= from;
    out.push({
      id: r.id,
      fileId: r.file_id,
      path: r.path,
      from: Buffer.from(r.anchor_from).toString('base64'),
      to: Buffer.from(r.anchor_to).toString('base64'),
      expected: r.expected,
      replacement: r.replacement,
      reason: r.reason,
      status: r.status,
      stale:
        r.status === 'open'
          ? !known || now !== r.expected
          : r.status === 'accepted' && (!known || now !== r.replacement),
      now,
      author: r.author_email,
      mine: r.author === userId,
      createdAt: r.created_at.toISOString(),
      decidedBy: r.decider_email,
      decidedAt: r.decided_at?.toISOString() ?? null,
    });
  }
  return out;
}
