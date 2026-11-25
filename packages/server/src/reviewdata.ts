// A paper's review as a file: its threads and proposed changes, to keep or to take elsewhere.
// Positions in the text do not travel (they belong to this copy's edit history), so each item
// goes out with the words it is about and what stands around them, and is placed by those when
// it comes back in.
import type { Db } from './db.ts';
import * as Y from 'yjs';
import { z } from 'zod';
import { authorize } from './authz.ts';
import { type BlobStore, sha256 } from './blobs.ts';
import { id } from './projects.ts';
import { listProposals } from './proposals.ts';
import { heldFileIds } from './revisions.ts';
import { loadUpdates, TEXT } from './sync.ts';
import { listThreads } from './threads.ts';

export const REVIEW_FILE = 'paperweave-review.json';
const FORMAT = 'paperweave-review-1';
const CONTEXT = 80;

const text = (max: number) => z.string().max(max);
// The app can write names and evidence longer than the file's limits (an address of 321
// characters signs in; evidence strings are not capped everywhere), so the reader trims them
// rather than refuse the item.
const who = z
  .string()
  .nullable()
  .transform((s) => s?.slice(0, 320) ?? null);
const when = z.iso.datetime();
const MAX_THREADS = 20_000;
const MAX_PROPOSALS = 20_000;
const MAX_COMMENTS = 5000;
/** Comments written by one statement. */
const COMMENT_CHUNK = 500;
const Thread = z.object({
  file: text(500),
  quote: text(500),
  /** The stretch was longer than the quote: how long, and its hash. Absent in older files. */
  length: z.number().int().min(1).max(50_000_000).optional(),
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  before: text(CONTEXT),
  after: text(CONTEXT),
  status: z.enum(['open', 'resolved']),
  startedBy: who,
  createdAt: when,
  /** The words were no longer in the paper when this was written: keep it detached. */
  detached: z.boolean().optional(),
  comments: z.array(z.object({ author: who, body: text(5000).min(1), createdAt: when })).min(1),
});
const Proposal = z.object({
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
  /** Absent in files written before this was kept. */
  decidedBy: who.optional(),
  origin: z.enum(['person', 'critique']),
  madeBy: text(200).nullable(),
  evidence: z.array(z.string().transform((s) => s.slice(0, 500))).transform((e) => e.slice(0, 10)),
  /** Open or accepted, and its words had been changed since: it stays stale. Absent in older files. */
  stale: z.boolean().optional(),
  /** An insertion (or undone deletion) whose place was deleted: there are no words to find it by. */
  placeLost: z.boolean().optional(),
});
// Items are read one by one, so that one bad item does not cost the rest.
const ReviewData = z.object({
  format: z.literal(FORMAT),
  paper: text(200),
  exported: when,
  /** The name of the version of the paper this came from. Absent for the paper itself, and in older files. */
  version: text(60).optional(),
  /** The path of the paper's root file where this came from. */
  root: z.string().max(255).optional(),
  threads: z.array(z.unknown()),
  proposals: z.array(z.unknown()),
  /** Files kept back from downloads whose threads and proposals were left out: counts only. */
  held: z
    .array(
      z.object({
        file: text(500),
        threads: z.number().int().min(0),
        proposals: z.number().int().min(0),
      }),
    )
    .max(1000)
    .optional(),
});
export type ReviewData = Omit<z.infer<typeof ReviewData>, 'threads' | 'proposals'> & {
  threads: z.input<typeof Thread>[];
  proposals: z.input<typeof Proposal>[];
};
/** The root file path a review file names, if it names one. */
export function carriedRoot(input: unknown): string | undefined {
  const r = z.object({ root: z.string().min(1).max(255) }).safeParse(input);
  return r.success ? r.data.root : undefined;
}
export type ReviewImport = {
  threads: number;
  proposals: number;
  /** Threads brought in whose text is not in the paper: kept, detached, with their words. */
  detached: number;
  /** What could not be brought in, and why. */
  missing: string[];
};

/** A file's saved text as a document, by path. */
export async function texts(pool: Db, store: BlobStore, projectId: string) {
  const { rows } = await pool.query(
    'select id, path from files where project_id = $1 and eol is not null',
    [projectId],
  );
  const open = new Map<string, { id: string; doc: Y.Doc; text: Y.Text; all: string }>();
  return async (path: string) => {
    const want = path.normalize('NFC');
    const file = rows.find((r) => r.path.normalize('NFC') === want);
    if (!file) return null;
    if (!open.has(path)) {
      const doc = new Y.Doc();
      for (const update of await loadUpdates(pool, store, file.id)) Y.applyUpdate(doc, update);
      const text = doc.getText(TEXT);
      // The text is read once: nothing here changes it, and a large file read for each thread
      // costs more than placing the thread.
      open.set(path, { id: file.id, doc, text, all: text.toString() });
    }
    return open.get(path)!;
  };
}

/** A paper's threads and proposed changes, as a document to keep. */
export async function exportReview(
  pool: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<ReviewData> {
  await authorize(pool, userId, id(projectId), 'project.export');
  const paper = (
    await pool.query(
      `select p.name, p.version_name as version, f.path as root from projects p left join files f on f.id = p.root_file_id
       where p.id = $1`,
      [projectId],
    )
  ).rows[0];
  const file = await texts(pool, store, projectId);
  // Data kept back from downloads keeps its comments and proposals back too, by file, not path.
  const held = await heldFileIds(pool, projectId);
  const left = new Map<string, { file: string; threads: number; proposals: number }>();
  const leave = (fileId: string, path: string, kind: 'threads' | 'proposals') => {
    const n = left.get(fileId) ?? { file: path, threads: 0, proposals: 0 };
    n[kind]++;
    left.set(fileId, n);
  };
  const threads = [];
  for (const t of await listThreads(pool, store, userId, projectId)) {
    if (held.has(t.fileId)) {
      leave(t.fileId, t.path, 'threads');
      continue;
    }
    // A thread goes by how it reads now. One whose words are gone keeps the words it started on.
    const base = {
      file: t.path,
      status: t.status,
      startedBy: t.startedBy,
      createdAt: t.createdAt,
      comments: t.comments.map((c) => ({
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
      })),
    };
    const f = (await file(t.path))!;
    const at = t.now
      ? Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(Buffer.from(t.from, 'base64')),
          f.doc,
        )?.index
      : undefined;
    if (t.state === 'detached' || at === undefined) {
      threads.push({ ...base, quote: t.excerpt, before: t.before, after: t.after, detached: true });
      continue;
    }
    const all = f.all;
    const end = at + t.now.length;
    // A stretch longer than the quote says how long it is and what it hashes to.
    const toIdx = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(t.to, 'base64')),
      f.doc,
    )?.index;
    const whole = toIdx !== undefined && toIdx - at > t.now.length ? all.slice(at, toIdx) : '';
    threads.push({
      ...base,
      quote: t.now,
      ...(whole && { length: whole.length, hash: sha256(Buffer.from(whole)) }),
      before: all.slice(Math.max(0, at - CONTEXT), at),
      after: all.slice(end, end + CONTEXT),
    });
  }
  const proposals = [];
  for (const p of await listProposals(pool, store, userId, projectId)) {
    if (held.has(p.fileId)) {
      leave(p.fileId, p.path, 'proposals');
      continue;
    }
    // What stands around the stretch now, to find it by later.
    const f = (await file(p.path))!;
    const at = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(p.from, 'base64')),
      f.doc,
    )?.index;
    const all = f.all;
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
      decidedBy: p.decidedBy,
      origin: p.origin,
      madeBy: p.madeBy,
      evidence: p.evidence,
      ...((p.status === 'open' || p.status === 'accepted') && p.stale ? { stale: true } : {}),
      ...(p.placeLost ? { placeLost: true } : {}),
    });
  }
  return {
    format: FORMAT,
    paper: paper.name,
    exported: new Date().toISOString(),
    ...(paper.version ? { version: paper.version } : {}),
    ...(paper.root ? { root: paper.root } : {}),
    threads,
    proposals,
    ...(left.size ? { held: [...left.values()].sort((a, b) => a.file.localeCompare(b.file)) } : {}),
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
 * and left out. One that was stale where it came from stays stale, and an insertion whose place
 * was lost is reported and left out. The people named in the data are kept as names.
 */
export async function importReview(
  pool: Db,
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
  for (const h of read.data.held ?? []) {
    const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
    const what = [h.threads && n(h.threads, 'thread'), h.proposals && n(h.proposals, 'proposal')]
      .filter(Boolean)
      .join(' and ');
    if (what)
      done.missing.push(
        `${what} on ${h.file} ${h.threads + h.proposals === 1 ? 'was' : 'were'} left out where this came from: the file is kept back from downloads.`,
      );
  }
  const file = await texts(pool, store, projectId);
  const short = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
  const place = (t: Y.Text, index: number, side: number) =>
    Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, index, side)));
  const cut = (n: number, max: number, what: string) =>
    n > max && done.missing.push(`${n - max} of ${n} ${what} in the archive were left out.`);
  cut(read.data.threads.length, MAX_THREADS, 'threads');
  cut(read.data.proposals.length, MAX_PROPOSALS, 'proposed changes');
  let unreadThreads = 0;
  let unreadProposals = 0;
  for (const raw of read.data.threads.slice(0, MAX_THREADS)) {
    const item = Thread.safeParse(raw);
    if (!item.success) {
      unreadThreads++;
      continue;
    }
    const t = item.data;
    const f = await file(t.file);
    if (!f) {
      done.missing.push(`A thread on “${short(t.quote)}”: the paper has no file ${t.file}.`);
      continue;
    }
    // A thread detached where it came from is not placed again by its old words, which may
    // have been typed elsewhere since.
    const all = f.all;
    const at = t.detached ? -1 : locateQuote(all, t.quote, t.before, t.after);
    // A longer stretch is kept whole if what stands there still hashes as it did; otherwise the
    // quote is all there is to go by.
    const whole =
      at >= 0 &&
      t.length !== undefined &&
      t.hash !== undefined &&
      t.length > t.quote.length &&
      sha256(Buffer.from(all.slice(at, at + t.length))) === t.hash;
    // Not there (or there too often to say where): the thread is kept, with nothing to point at.
    const [from, to] = at < 0 ? [0, 0] : [at, at + (whole ? t.length! : t.quote.length)];
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
          whole ? t.hash : sha256(Buffer.from(t.quote)),
          t.status,
          t.createdAt,
          t.startedBy,
        ],
      )
    ).rows[0];
    if (t.comments.length > MAX_COMMENTS)
      done.missing.push(
        `A thread on “${short(t.quote)}” had ${t.comments.length} comments; the last ${t.comments.length - MAX_COMMENTS} were left out.`,
      );
    // The file's order is the thread's order, though listThreads sorts by time: a comment is
    // never stored earlier than a microsecond after the one before it, so ties do not reshuffle.
    // Comment n of a chunk is stored at the latest of its own time and that of every comment
    // before it, each pushed on by a microsecond per step: n microseconds plus the greatest of
    // (time - k microseconds) over k up to n, and of the last time stored by the chunk before.
    const kept = t.comments.slice(0, MAX_COMMENTS);
    let prev: string | null = null;
    for (let i = 0; i < kept.length; i += COMMENT_CHUNK) {
      const chunk = kept.slice(i, i + COMMENT_CHUNK);
      prev = (
        await pool.query(
          `with given as (
             select body, at, author, n
               from unnest($2::text[], $3::timestamptz[], $4::text[])
                    with ordinality as u(body, at, author, n)
           ), ins as (
             insert into thread_comments (thread_id, body, created_at, imported_author)
             select $1, body,
                    n * interval '1 microsecond' + greatest(
                      max(at - n * interval '1 microsecond') over (order by n),
                      $5::timestamptz),
                    author
               from given
             returning created_at
           )
           select max(created_at)::text as at from ins`,
          [
            made.id,
            chunk.map((c) => c.body),
            chunk.map((c) => c.createdAt),
            chunk.map((c) => c.author),
            prev,
          ],
        )
      ).rows[0].at;
    }
    done.threads++;
  }
  for (const raw of read.data.proposals.slice(0, MAX_PROPOSALS)) {
    const item = Proposal.safeParse(raw);
    if (!item.success) {
      unreadProposals++;
      continue;
    }
    const p = item.data;
    const f = await file(p.file);
    // A stale open proposal is not placed by its words: they may since have been typed somewhere
    // else, and it would read as fresh there.
    const openStale = p.status === 'open' && p.stale === true;
    if (f && openStale && (p.expected === '' || p.placeLost)) {
      // An insertion has no words to find its place by.
      done.missing.push(
        `A proposal to add “${short(p.replacement)}” in ${p.file}: the place it was to be added at was no longer in the file.`,
      );
      continue;
    }
    // An accepted proposal's stretch is what it put there; any other's is what it would replace.
    const stands = p.status === 'accepted' ? p.replacement : p.expected;
    const stale = openStale || (p.status === 'accepted' && p.stale === true);
    // One that had gone stale is anchored where it does not read as its words, so that it is
    // stale here too.
    const at = !f ? -1 : stale ? 0 : locateQuote(f.all, stands, p.before, p.after);
    if (!f || at < 0) {
      done.missing.push(
        `A proposal to change “${short(p.expected)}” in ${p.file}: ${f ? 'that text is not in the file, or is there more than once' : 'the paper has no such file'}.`,
      );
      continue;
    }
    // A stale one covers nothing, or one character if its replacement is empty (which an empty
    // stretch would match). An open one that is stale has words, and an empty stretch is not them.
    const length = stale
      ? p.status === 'accepted' && p.replacement === ''
        ? Math.min(1, f.text.length)
        : 0
      : stands.length;
    await pool.query(
      `insert into proposals (project_id, file_id, anchor_from, anchor_to, expected, replacement,
         reason, status, created_at, decided_at, origin, made_by, evidence, imported_author, imported_decider)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        projectId,
        f.id,
        place(f.text, at, 0),
        place(f.text, at + length, -1),
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
        p.decidedBy ?? null,
      ],
    );
    done.proposals++;
  }
  const left = (n: number, one: string, many: string) =>
    n === 1
      ? `A ${one} in the archive could not be read, and was left out.`
      : `${n} ${many} in the archive could not be read, and were left out.`;
  if (unreadThreads) done.missing.push(left(unreadThreads, 'thread', 'threads'));
  if (unreadProposals)
    done.missing.push(left(unreadProposals, 'proposed change', 'proposed changes'));
  return done;
}
