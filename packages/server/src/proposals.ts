// Proposed edits: "replace this stretch with that". Anyone who may comment can propose one;
// only someone who may edit can accept it, and only then does it touch the paper. Accepting
// goes through the command path, so it lands exactly as proposed or not at all.
import type pg from 'pg';
import * as Y from 'yjs';
import { authorize, can } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type ClaimChange, claimChanges, describeClaimChange, sentenceAround } from './claims.ts';
import { type DeleteSet, placeLost, runCommand } from './commands.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { docsOf, loadUpdates, TEXT } from './sync.ts';

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
  /**
   * An insertion (open) or a deletion (accepted) whose place was lost: the text on one side of
   * it was deleted. It cannot be accepted or put back, and a place cannot be found again.
   */
  placeLost: boolean;
  /** The stretch as it reads now. */
  now: string;
  /**
   * What accepting it would change about what the passage claims, besides its wording: a
   * number, a negation, a cause, a citation. In words, for whoever decides.
   */
  flags: string[];
  /** A person wrote it, or a model review did at a person's request. */
  origin: 'person' | 'critique';
  /** For a model review: the model and the version of the claim rules. */
  madeBy: string | null;
  /** For a model review: what in the passage the change rests on. */
  evidence: string[];
  author: string | null;
  /** Whether the person asking wrote it. */
  mine: boolean;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
};

const MAX = 20_000;
const bad = (why: string) => new AppError('invalid_input', why);

async function textOf(
  pool: Db,
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
  // Its words have gone from the file and its place has closed up. Saved now, it would become a
  // proposal to add text at wherever that left it. Only a proposal made to add text has no words.
  if (to === from && p.expected !== '')
    throw new AppError(
      'conflict',
      'The words this was about are no longer in the file. Find them again, or make a new proposal.',
    );
  if (
    p.expected === '' &&
    placeLost(Y.createDeleteSetFromStructStore(doc.store), p.anchor_from, p.anchor_to)
  )
    throw new AppError(
      'conflict',
      'The place this was to be added at is no longer in the file. Make a new proposal.',
    );
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
 * Attach a proposal whose place has been lost to the same words where they stand now. Only when
 * there is no doubt which words are meant: they are in the file exactly once. Who may: the same
 * as may change it.
 */
export async function reattachProposal(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  proposalId: string,
): Promise<void> {
  const role = await authorize(pool, userId, id(projectId), 'proposal.create');
  const p = await find(pool, projectId, proposalId);
  if (p.author !== userId && !can(role, 'proposal.decide'))
    throw new AppError('permission_denied', 'Only its author or an editor can change a proposal.');
  if (p.status !== 'open' && p.status !== 'accepted')
    throw new AppError('conflict', 'That proposal has been decided.');
  const words: string = p.status === 'open' ? p.expected : p.replacement;
  if (words === '')
    throw new AppError(
      'conflict',
      'This proposal is about a place, not words, and a place cannot be found again. Make a new proposal.',
    );
  const { doc, text } = await textOf(pool, store, p.file_id);
  const [from, to] = [locate(doc, text, p.anchor_from), locate(doc, text, p.anchor_to)];
  const all = text.toString();
  if (from >= 0 && to >= from && all.slice(from, to) === words)
    throw bad('That proposal is still attached to its words.');
  const at = all.indexOf(words);
  if (at < 0) throw new AppError('conflict', 'Those words are not in the file now.');
  if (all.indexOf(words, at + 1) >= 0)
    throw new AppError(
      'conflict',
      'Those words are in the file more than once. Make a new proposal on the ones you mean.',
    );
  const place = (index: number, side: number) =>
    Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, side)));
  await pool.query('update proposals set anchor_from = $2, anchor_to = $3 where id = $1', [
    p.id,
    place(at, 0),
    place(at + words.length, -1),
  ]);
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
      exactPlace: true,
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
      exactPlace: true,
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
  pool: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId?: string,
): Promise<Proposal[]> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const { rows } = await pool.query(
    `select p.id, p.file_id, f.path, p.anchor_from, p.anchor_to, p.expected, p.replacement,
            p.reason, p.status, p.author, p.created_at, p.decided_at,
            coalesce(a.email, p.imported_author) as author_email,
            p.origin, p.made_by, p.evidence,
            coalesce(d.email, p.imported_decider) as decider_email
     from proposals p join files f on f.id = p.file_id
     left join "user" a on a.id = p.author left join "user" d on d.id = p.decided_by
     where p.project_id = $1 and ($2::uuid is null or p.file_id = $2)
     order by p.created_at, p.id`,
    [projectId, fileId === undefined ? null : id(fileId)],
  );
  // For the whole paper, every log is read in one statement; for one file, only its own.
  const logs = rows.length && fileId === undefined ? await docsOf(pool, projectId) : undefined;
  const texts = new Map<string, Awaited<ReturnType<typeof textOf>>>();
  const deletes = new Map<string, DeleteSet>();
  const out: Proposal[] = [];
  for (const r of rows) {
    if (!texts.has(r.file_id)) texts.set(r.file_id, await textOf(pool, store, r.file_id, logs));
    const { doc, text } = texts.get(r.file_id)!;
    // Built once for the file, not once for each of its proposals.
    if (!deletes.has(r.file_id))
      deletes.set(r.file_id, Y.createDeleteSetFromStructStore(doc.store));
    const [from, to] = [locate(doc, text, r.anchor_from), locate(doc, text, r.anchor_to)];
    const known = from >= 0 && to >= from;
    const whole = text.toString();
    const now = known ? whole.slice(from, to) : '';
    // A change is judged in the sentence it stands in, not as the words alone: "high" for "low"
    // says nothing until it is seen in what it is high or low about. Only the open ones show flags.
    let flags: ClaimChange[] = [];
    if (r.status === 'open') {
      if (known && now === r.expected) {
        const [start, end] = sentenceAround(whole, from, to);
        flags = claimChanges(
          whole.slice(start, end),
          whole.slice(start, from) + r.replacement + whole.slice(to, end),
        );
      } else flags = claimChanges(r.expected, r.replacement);
    }
    const lost =
      (r.status === 'open' ? r.expected === '' : r.status === 'accepted' && r.replacement === '') &&
      placeLost(deletes.get(r.file_id)!, r.anchor_from, r.anchor_to);
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
        lost ||
        (r.status === 'open'
          ? !known || now !== r.expected
          : r.status === 'accepted' && (!known || now !== r.replacement)),
      placeLost: lost,
      now,
      flags: flags.map(describeClaimChange),
      origin: r.origin,
      madeBy: r.made_by,
      evidence: r.evidence,
      author: r.author_email,
      mine: r.author === userId,
      createdAt: r.created_at.toISOString(),
      decidedBy: r.decider_email,
      decidedAt: r.decided_at?.toISOString() ?? null,
    });
  }
  return out;
}
