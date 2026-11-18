// A paper's review as a file: its threads and proposed changes, to keep or to take elsewhere.
// Positions in the text do not travel (they belong to this copy's edit history), so each item
// goes out with the words it is about and what stands around them, and is placed by those when
// it comes back in.
import type pg from 'pg';
import * as Y from 'yjs';
import { z } from 'zod';
import { authorize } from './authz.ts';
import { type BlobStore, sha256 } from './blobs.ts';
import { id } from './projects.ts';
import { listProposals } from './proposals.ts';
import { loadUpdates, TEXT } from './sync.ts';
import { listThreads } from './threads.ts';

export const REVIEW_FILE = 'paperweave-review.json';
const FORMAT = 'paperweave-review-1';
const CONTEXT = 80;

const text = (max: number) => z.string().max(max);
const who = text(320).nullable();
const when = z.iso.datetime();
const ReviewData = z.object({
  format: z.literal(FORMAT),
  paper: text(200),
  exported: when,
  threads: z
    .array(
      z.object({
        file: text(500),
        quote: text(500),
        before: text(CONTEXT),
        after: text(CONTEXT),
        status: z.enum(['open', 'resolved']),
        startedBy: who,
        createdAt: when,
        comments: z
          .array(z.object({ author: who, body: text(5000).min(1), createdAt: when }))
          .min(1)
          .max(500),
      }),
    )
    .max(2000),
  proposals: z
    .array(
      z.object({
        file: text(500),
        expected: text(20_000),
        replacement: text(20_000),
        before: text(CONTEXT),
        after: text(CONTEXT),
        reason: text(1000),
        status: z.enum(['open', 'accepted', 'rejected', 'dismissed']),
        author: who,
        createdAt: when,
        decidedAt: when.nullable(),
        origin: z.enum(['person', 'critique']),
        madeBy: text(200).nullable(),
        evidence: z.array(text(500)).max(10),
      }),
    )
    .max(2000),
});
export type ReviewData = z.infer<typeof ReviewData>;
export type ReviewImport = {
  threads: number;
  proposals: number;
  /** Threads brought in whose text is not in the paper: kept, detached, with their words. */
  detached: number;
  /** What could not be brought in, and why. */
  missing: string[];
};

/** A file's saved text as a document, by path. */
async function texts(pool: pg.Pool, store: BlobStore, projectId: string) {
  const { rows } = await pool.query(
    'select id, path from files where project_id = $1 and eol is not null',
    [projectId],
  );
  const open = new Map<string, { id: string; doc: Y.Doc; text: Y.Text }>();
  return async (path: string) => {
    const file = rows.find((r) => r.path === path);
    if (!file) return null;
    if (!open.has(path)) {
      const doc = new Y.Doc();
      for (const update of await loadUpdates(pool, store, file.id)) Y.applyUpdate(doc, update);
      open.set(path, { id: file.id, doc, text: doc.getText(TEXT) });
    }
    return open.get(path)!;
  };
}

/** A paper's threads and proposed changes, as a document to keep. */
export async function exportReview(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<ReviewData> {
  await authorize(pool, userId, id(projectId), 'project.export');
  const paper = (await pool.query('select name from projects where id = $1', [projectId])).rows[0];
  const file = await texts(pool, store, projectId);
  const proposals = [];
  for (const p of await listProposals(pool, store, userId, projectId)) {
    // What stands around the stretch now, to find it by later.
    const f = (await file(p.path))!;
    const at = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(p.from, 'base64')),
      f.doc,
    )?.index;
    const all = f.text.toString();
    const end = at === undefined ? 0 : at + p.now.length;
    proposals.push({
      file: p.path,
      expected: p.expected,
      replacement: p.replacement,
      before: at === undefined ? '' : all.slice(Math.max(0, at - CONTEXT), at),
      after: at === undefined ? '' : all.slice(end, end + CONTEXT),
      reason: p.reason,
      status: p.status,
      author: p.author,
      createdAt: p.createdAt,
      decidedAt: p.decidedAt,
      origin: p.origin,
      madeBy: p.madeBy,
      evidence: p.evidence,
    });
  }
  return {
    format: FORMAT,
    paper: paper.name,
    exported: new Date().toISOString(),
    threads: (await listThreads(pool, store, userId, projectId)).map((t) => ({
      file: t.path,
      quote: t.excerpt,
      before: t.before,
      after: t.after,
      status: t.status,
      startedBy: t.startedBy,
      createdAt: t.createdAt,
      comments: t.comments.map((c) => ({
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
      })),
    })),
    proposals,
  };
}

/**
 * Where words stand in a text: the one place they are, or, if they are there more than once,
 * the place with the same surroundings. -1 if that cannot be told.
 */
export function locateQuote(all: string, quote: string, before: string, after: string): number {
  const places: number[] = [];
  if (quote)
    for (let at = all.indexOf(quote); at >= 0; at = all.indexOf(quote, at + 1)) places.push(at);
  else if (before || after) {
    // Nothing to find but a place between two stretches of text.
    const at = all.indexOf(before + after);
    return at < 0 || all.indexOf(before + after, at + 1) >= 0 ? -1 : at + before.length;
  }
  if (places.length === 1) return places[0];
  const fits = places.filter(
    (at) =>
      all.slice(0, at).endsWith(before.slice(-20)) &&
      all.slice(at + quote.length).startsWith(after.slice(0, 20)),
  );
  return fits.length === 1 ? fits[0] : -1;
}

/**
 * Bring review data into a paper. Each thread and proposal is placed by its words; a thread
 * whose words are not there is kept detached, and a proposal that cannot be placed is reported
 * and left out. The people named in the data are kept as names.
 */
export async function importReview(
  pool: pg.Pool,
  store: BlobStore,
  projectId: string,
  input: unknown,
): Promise<ReviewImport> {
  const done: ReviewImport = { threads: 0, proposals: 0, detached: 0, missing: [] };
  const read = ReviewData.safeParse(input);
  if (!read.success) {
    done.missing.push('The review data in the archive could not be read, so none was brought in.');
    return done;
  }
  const file = await texts(pool, store, projectId);
  const short = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
  const place = (t: Y.Text, index: number, side: number) =>
    Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, index, side)));
  for (const t of read.data.threads) {
    const f = await file(t.file);
    if (!f) {
      done.missing.push(`A thread on “${short(t.quote)}”: the paper has no file ${t.file}.`);
      continue;
    }
    const at = locateQuote(f.text.toString(), t.quote, t.before, t.after);
    // Not there (or there too often to say where): the thread is kept, with nothing to point at.
    const [from, to] = at < 0 ? [0, 0] : [at, at + t.quote.length];
    if (at < 0) done.detached++;
    const made = (
      await pool.query(
        `insert into threads (project_id, file_id, anchor_from, anchor_to, excerpt, context_before,
           context_after, fingerprint, status, created_at, imported_author)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [
          projectId,
          f.id,
          place(f.text, from, 0),
          place(f.text, to, -1),
          t.quote,
          t.before,
          t.after,
          sha256(Buffer.from(t.quote)),
          t.status,
          t.createdAt,
          t.startedBy,
        ],
      )
    ).rows[0];
    for (const c of t.comments)
      await pool.query(
        `insert into thread_comments (thread_id, body, created_at, imported_author)
         values ($1, $2, $3, $4)`,
        [made.id, c.body, c.createdAt, c.author],
      );
    done.threads++;
  }
  for (const p of read.data.proposals) {
    const f = await file(p.file);
    // An accepted proposal's stretch is what it put there; any other's is what it would replace.
    const stands = p.status === 'accepted' ? p.replacement : p.expected;
    const at = f ? locateQuote(f.text.toString(), stands, p.before, p.after) : -1;
    if (!f || at < 0) {
      done.missing.push(
        `A proposal to change “${short(p.expected)}” in ${p.file}: ${f ? 'that text is not in the file, or is there more than once' : 'the paper has no such file'}.`,
      );
      continue;
    }
    await pool.query(
      `insert into proposals (project_id, file_id, anchor_from, anchor_to, expected, replacement,
         reason, status, created_at, decided_at, origin, made_by, evidence, imported_author)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        projectId,
        f.id,
        place(f.text, at, 0),
        place(f.text, at + stands.length, -1),
        p.expected,
        p.replacement,
        p.reason,
        p.status,
        p.createdAt,
        p.decidedAt,
        p.origin,
        p.madeBy,
        JSON.stringify(p.evidence),
        p.author,
      ],
    );
    done.proposals++;
  }
  return done;
}
