// Bringing a version's open threads and proposals across on a merge (PLAN.md section 14, V9).
// Optional, and done after the merge has committed, so it can never change what the merge wrote:
// it only reads the merged text. An item is copied, not moved: the source keeps its own.
//
// - Which: open threads and open proposals of the source, on a file that is the same file in the
//   target (`coalesce(origin_id, id)`), and not already carried (a second merge copies nothing
//   twice). Resolved, accepted, rejected and dismissed ones are never carried.
// - Where: found in the merged text of the target by its words and what stood around them, as a
//   review file's import does (`locateQuote`). If the words are not there, or are there more
//   than once with nothing to tell them apart, it is not carried: it is listed, and stays on the
//   source only. A thread already detached, a proposal already out of date and an insertion whose
//   place was deleted have no words to go by and are listed the same way.
// - Who: authors are kept as they are (the person, or the name an import left), with their times.
//   Mentions are not copied (they named people of the source paper and were sent when written),
//   so a carried comment mentions and notifies no one. Nothing here touches who is a member of
//   either paper, and the copy is read by the target's people as any thread of it is.
import * as Y from 'yjs';
import { sha256, type BlobStore } from './blobs.ts';
import type { Db } from './db.ts';
import { locateQuote, texts } from './reviewdata.ts';
import { listProposals } from './proposals.ts';
import { heldFileIds } from './revisions.ts';
import { listThreads } from './threads.ts';

const CONTEXT = 80;
const EXCERPT = 500;

export type Carried = {
  threads: number;
  proposals: number;
  /** What was not brought across, and why: one line each, with no text of the paper beyond a few words. */
  left: string[];
  /** How many items `left` speaks of (a line may speak of several). */
  notCarried: number;
};

const short = (s: string) => (s.length > 30 ? `${s.slice(0, 30)}…` : s);
const here = (doc: Y.Doc, text: Y.Text, base64: string) => {
  try {
    const at = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(base64, 'base64')),
      doc,
    );
    return at?.type === text ? at.index : -1;
  } catch {
    return -1;
  }
};

/** Copy the source's open threads and proposals that can be placed into the target. */
export async function carryReview(
  pool: Db,
  store: BlobStore,
  userId: string,
  targetId: string,
  sourceId: string,
): Promise<Carried> {
  const done: Carried = { threads: 0, proposals: 0, left: [], notCarried: 0 };
  // The same file in both papers, by origin.
  const pairs = (
    await pool.query(
      `select s.id as source, t.id as target, s.path as source_path, t.path as target_path
       from files s join files t on coalesce(s.origin_id, s.id) = coalesce(t.origin_id, t.id)
       where s.project_id = $1 and t.project_id = $2 and s.eol is not null and t.eol is not null`,
      [sourceId, targetId],
    )
  ).rows;
  const pair = new Map(pairs.map((p) => [p.source as string, p]));
  const held = await heldFileIds(pool, sourceId);
  const seen = async (table: 'threads' | 'proposals') =>
    new Set(
      (
        await pool.query(
          // Already carried into the target, or itself a copy of something of the target's.
          `select s.id from ${table} s where s.project_id = $1 and (
             exists (select 1 from ${table} c where c.project_id = $2 and c.carried_from = s.id)
             or exists (select 1 from ${table} c where c.project_id = $2 and c.id = s.carried_from))`,
          [sourceId, targetId],
        )
      ).rows.map((r) => r.id as string),
    );
  const source = await texts(pool, store, sourceId);
  const target = await texts(pool, store, targetId);
  const place = (t: Y.Text, index: number, side: number) =>
    Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, index, side)));
  const ahead = (n: number, what: string, why: string) =>
    done.left.push(`${n} ${what}${n === 1 ? '' : 's'} ${why}`);
  // Items left for a reason that is not about their words are counted, not listed one by one.
  const skipped = { file: 0, held: 0 };

  const carriedThreads = await seen('threads');
  for (const th of await listThreads(pool, store, userId, sourceId)) {
    if (th.status !== 'open' || carriedThreads.has(th.id)) continue;
    const p = pair.get(th.fileId);
    if (!p) {
      skipped.file++;
      continue;
    }
    if (held.has(th.fileId)) {
      skipped.held++;
      continue;
    }
    const s = (await source(p.source_path))!;
    const [a, b] = [here(s.doc, s.text, th.from), here(s.doc, s.text, th.to)];
    const words = a >= 0 && b > a ? s.all.slice(a, b) : '';
    const f = (await target(p.target_path))!;
    const at = words
      ? locateQuote(
          f.all,
          words,
          s.all.slice(Math.max(0, a - CONTEXT), a),
          s.all.slice(b, b + CONTEXT),
        )
      : -1;
    if (at < 0) {
      done.notCarried++;
      done.left.push(
        `A thread on “${short(words || th.excerpt)}” in ${p.target_path}: ${words ? 'those words are not in the merged text, or are there more than once' : 'it was already detached'}.`,
      );
      continue;
    }
    const made = (
      await pool.query(
        `insert into threads (project_id, file_id, anchor_from, anchor_to, excerpt, context_before,
           context_after, fingerprint, status, created_by, created_at, imported_author, carried_from)
         select $1, $2, $3, $4, $5, t.context_before, t.context_after, $6, 'open', t.created_by,
                t.created_at, t.imported_author, t.id
         from threads t where t.id = $7
         on conflict (project_id, carried_from) where carried_from is not null do nothing
         returning id`,
        [
          targetId,
          f.id,
          place(f.text, at, 0),
          place(f.text, at + words.length, -1),
          words.slice(0, EXCERPT),
          sha256(Buffer.from(words)),
          th.id,
        ],
      )
    ).rows[0];
    if (!made) continue;
    // Comments as they stand: the live ones, with their authors, times and edits. No mentions.
    await pool.query(
      `insert into thread_comments (thread_id, author, body, created_at, edited_at, imported_author)
       select $1, c.author, c.body, c.created_at, c.edited_at, c.imported_author
       from thread_comments c where c.thread_id = $2 and c.deleted_at is null
       order by c.created_at, c.id`,
      [made.id, th.id],
    );
    done.threads++;
  }

  const carriedProposals = await seen('proposals');
  for (const pr of await listProposals(pool, store, userId, sourceId)) {
    if (pr.status !== 'open' || carriedProposals.has(pr.id)) continue;
    const p = pair.get(pr.fileId);
    if (!p) {
      skipped.file++;
      continue;
    }
    if (held.has(pr.fileId)) {
      skipped.held++;
      continue;
    }
    const s = (await source(p.source_path))!;
    const a = here(s.doc, s.text, pr.from);
    const f = (await target(p.target_path))!;
    // A proposal out of date where it is, or an insertion whose place was deleted, has no words
    // to be placed by.
    const at =
      pr.stale || pr.placeLost || a < 0
        ? -1
        : locateQuote(
            f.all,
            pr.expected,
            s.all.slice(Math.max(0, a - CONTEXT), a),
            s.all.slice(a + pr.expected.length, a + pr.expected.length + CONTEXT),
          );
    if (at < 0) {
      done.notCarried++;
      done.left.push(
        `A proposal to change “${short(pr.expected || pr.replacement)}” in ${p.target_path}: ${pr.stale || pr.placeLost || a < 0 ? 'it was already out of date' : 'that text is not in the merged text, or is there more than once'}.`,
      );
      continue;
    }
    const made = (
      await pool.query(
        `insert into proposals (project_id, file_id, author, anchor_from, anchor_to, expected,
           replacement, reason, status, created_at, origin, made_by, evidence, imported_author,
           carried_from)
         select $1, $2, p.author, $3, $4, p.expected, p.replacement, p.reason, 'open', p.created_at,
                p.origin, p.made_by, p.evidence, p.imported_author, p.id
         from proposals p where p.id = $5
         on conflict (project_id, carried_from) where carried_from is not null do nothing
         returning id`,
        [targetId, f.id, place(f.text, at, 0), place(f.text, at + pr.expected.length, -1), pr.id],
      )
    ).rows[0];
    if (made) done.proposals++;
  }
  done.notCarried += skipped.file + skipped.held;
  if (skipped.file)
    ahead(
      skipped.file,
      'item',
      'on files the other paper does not have (or has under no name that matches).',
    );
  if (skipped.held) ahead(skipped.held, 'item', 'on files kept back from downloads.');
  return done;
}

/** How many open threads and proposals the source holds that a merge could bring across. */
export async function openReview(pool: Db, targetId: string, sourceId: string) {
  const { rows } = await pool.query(
    `select
       (select count(*)::int from threads t where t.project_id = $1 and t.status = 'open'
          and not exists (select 1 from threads c where c.project_id = $2 and (c.carried_from = t.id or c.id = t.carried_from))
          and exists (select 1 from thread_comments c where c.thread_id = t.id and c.deleted_at is null)) as threads,
       (select count(*)::int from proposals p where p.project_id = $1 and p.status = 'open'
          and not exists (select 1 from proposals c where c.project_id = $2 and (c.carried_from = p.id or c.id = p.carried_from))) as proposals`,
    [sourceId, targetId],
  );
  return rows[0] as { threads: number; proposals: number };
}
