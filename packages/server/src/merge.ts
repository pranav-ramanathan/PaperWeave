// Comparing across versions, and the merge plan. A version is a paper of its own whose files carry
// the `origin_id` of the file they were copied from, so a file is the same file in a paper and in
// its versions when `coalesce(origin_id, id)` agrees, whatever it has been renamed or moved to.
//
// Nothing here changes a paper's text. `planMerge` cuts both sides as revisions (as a restore does)
// and works out, for each file, what a merge would do, using the version's `base_revision_id` as
// the common base. Applying the plan is `applyMerge` (not written yet); what it needs to refuse a
// merge made stale is recorded in the plan: see `MergePlan.target`.
import type pg from 'pg';
import { decodeFile } from '@paperweave/latex';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import {
  blob,
  cutRevision,
  diffLoaded,
  type FileDiff,
  heldFileIds,
  WHOLE_FILE_BYTES,
} from './revisions.ts';
import {
  type MergeChoice,
  type MergeConflict,
  type MergeResult,
  merge3,
  resolveMerge,
} from './textdiff.ts';

export type Family = { id: string; parent: string | null };

/** The papers' family rows, after each has been authorized for `action`: `not_found` for outsiders. */
export async function members(
  db: Db,
  userId: string,
  papers: string[],
  action: 'project.read' | 'revision.write',
): Promise<Family[]> {
  for (const p of papers) await authorize(db, userId, id(p), action);
  const { rows } = await db.query(
    'select id, parent_id as parent from projects where id = any($1::uuid[])',
    [papers],
  );
  return papers.map((p) => {
    const row = rows.find((r) => r.id === p);
    if (!row) throw new AppError('not_found', 'No such project.');
    return row;
  });
}

const root = (p: Family) => p.parent ?? p.id;

/** Of two papers to merge, the one that is a version of the other; anything else is refused. */
export function versionOf(target: Family, source: Family): Family {
  if (target.id === source.id)
    throw new AppError('invalid_input', 'A paper cannot be merged into itself.');
  const version =
    target.parent === source.id ? target : source.parent === target.id ? source : null;
  if (!version)
    throw new AppError(
      'invalid_input',
      'Only a version and the paper it was started from can be merged.',
    );
  return version;
}

export const noBase = () =>
  new AppError(
    'conflict',
    'The revision this version began at is gone, so there is nothing to merge from.',
  );

/** A file of a revision with the identity it has across versions. */
type Entry = { key: string; fileId: string; path: string; digest: string; seq: string };

type Loaded = {
  paper: string;
  number: number;
  root: string | null;
  compiler: string | null;
  files: Entry[];
};

/** A revision, its files keyed by origin. Whichever paper of the family it belongs to. */
async function loadByOrigin(db: Db, revisionId: string): Promise<Loaded> {
  const rev = (
    await db.query('select project_id, number, root, compiler from revisions where id = $1', [
      id(revisionId),
    ])
  ).rows[0];
  if (!rev) throw new AppError('not_found', 'No such revision.');
  const { rows } = await db.query(
    `select rf.file_id, rf.path, rf.digest, rf.seq, coalesce(f.origin_id, f.id) as key
     from revision_files rf join all_files f on f.id = rf.file_id
     where rf.revision_id = $1 order by rf.path`,
    [revisionId],
  );
  const seen = new Set<string>();
  const files: Entry[] = [];
  for (const r of rows) {
    // One file per identity in a revision; a second would be a copy made by hand.
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    files.push({
      key: r.key,
      fileId: r.file_id,
      path: r.path,
      digest: r.digest,
      seq: String(r.seq),
    });
  }
  return {
    paper: rev.project_id,
    number: rev.number,
    root: rev.root,
    compiler: rev.compiler,
    files,
  };
}

// ----- Compare -----------------------------------------------------------------------------------

/** One side of a comparison: a paper, and one of its revisions or (omitted) the paper as it is now. */
export type CompareSide = { paper: string; revision?: string };

export type Comparison = {
  from: { paper: string; number: number };
  to: { paper: string; number: number };
  files: FileDiff[];
};

/**
 * The paper as it is now, as a revision: cut for those who may write (the latest revision if
 * nothing changed), and for everyone else the latest there is.
 */
async function nowOf(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  paper: string,
): Promise<string> {
  try {
    await authorize(pool, userId, id(paper), 'revision.write');
    return (await cutRevision(pool, store, userId, paper)).id;
  } catch (err) {
    if ((err as { code?: string }).code !== 'permission_denied') throw err;
    const { rows } = await pool.query(
      'select id from revisions where project_id = $1 order by number desc limit 1',
      [paper],
    );
    if (!rows[0]) throw new AppError('not_found', 'This paper has no revisions.');
    return rows[0].id;
  }
}

/**
 * What changed between a revision (or the current state) of one paper and a revision (or the
 * current state) of another paper of the same family, such as a version and its main. Files are
 * paired by origin, so a file renamed or moved on one side is the same file, shown as renamed (and
 * changed, if its text differs). The rest is `diffRevisions`' comparison. Anyone who may read both
 * papers may compare; papers of different families are refused.
 */
export async function compareAcross(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  from: CompareSide,
  to: CompareSide,
): Promise<Comparison> {
  const [a, b] = await members(pool, userId, [from.paper, to.paper], 'project.read');
  if (root(a) !== root(b))
    throw new AppError('invalid_input', 'These papers are not versions of one paper.');
  const fromRev = from.revision ?? (await nowOf(pool, store, userId, from.paper));
  const toRev = to.revision ?? (await nowOf(pool, store, userId, to.paper));
  const x = await loadByOrigin(pool, fromRev);
  const y = await loadByOrigin(pool, toRev);
  // A revision must be of the paper it is given with.
  if (x.paper !== from.paper || y.paper !== to.paper)
    throw new AppError('not_found', 'No such revision.');
  const keyed = (l: Loaded) => ({
    revision: { number: l.number },
    files: l.files.map((f) => ({ file_id: f.key, path: f.path, digest: f.digest })),
  });
  const held = async () => {
    // Held data is held on the file's origin, whichever paper says so.
    const ids = new Set<string>();
    for (const l of [x, y]) {
      const own = await heldFileIds(pool, l.paper);
      for (const f of l.files) if (own.has(f.fileId)) ids.add(f.key);
    }
    return ids;
  };
  const diff = await diffLoaded(pool, store, keyed(x), keyed(y), held);
  return {
    from: { paper: x.paper, number: x.number },
    to: { paper: y.paper, number: y.number },
    files: diff.files,
  };
}

// ----- The plan ----------------------------------------------------------------------------------

/**
 * What a merge does with one file. `ours` is the target (the paper merged into), `theirs` the
 * source (the paper merged from).
 *
 * - `unchanged`: the same on both sides.
 * - `kept`: only the target changed it (text, name, or it added it); nothing to do.
 * - `taken`: only the source changed it (text or name); the target gets the source's.
 * - `merged`: both changed the text and the changes merge without a conflict (`text`).
 * - `added`: the source added it; the target gets a new file.
 * - `removed`: the source deleted it and the target did not touch it; the target's is deleted.
 * - `conflict`: it needs a decision (`conflicts` lists what).
 */
export type MergeStatus =
  'unchanged' | 'kept' | 'taken' | 'merged' | 'added' | 'removed' | 'conflict';

export type ChoiceName = 'ours' | 'theirs' | 'both' | 'base' | 'text';

export type PlanConflict = {
  /** Stable for the same three revisions: the file's origin, and for a stretch of text its number. */
  id: string;
  key: string;
  /** The file's path in the target (or, if it is not there, in the source). */
  path: string;
  /**
   * `text`: a stretch of text both sides changed (`textKind` says how; `too-large` is the whole
   * file). `binary`: not text, changed on both sides. `deleted-vs-changed`: one side deleted the
   * file, the other changed it. `renamed`: given two names. `path-taken`: the source's file wants
   * a path another file of the target has.
   */
  kind: 'text' | 'binary' | 'deleted-vs-changed' | 'renamed' | 'path-taken';
  textKind?: MergeConflict['kind'];
  /** From 1, in the base. */
  line?: number;
  /** The three texts of a stretch (a text conflict; empty strings where a side has none). */
  base?: string;
  ours?: string;
  theirs?: string;
  /** Where each stretch sits in its own text, `[start, end)` in characters. */
  offsets?: {
    base: [number, number];
    ours: [number, number];
    theirs: [number, number];
    /** Where `ours` sits in the file's merged text with ours kept at every conflict. */
    merged: number;
  };
  /** For a whole-file conflict, the two files (`null` where the side has none). */
  oursFile?: { path: string; digest: string } | null;
  theirsFile?: { path: string; digest: string } | null;
  /** What may be chosen. A stretch of text: ours, theirs, both (ours first), or text written by hand. */
  choices: ChoiceName[];
};

/** What the apply step needs to know of a file of the target as the plan saw it. */
export type TargetFile = { fileId: string; path: string; headSeq: string };

export type PlannedFile = {
  /** The file's identity across versions (`coalesce(origin_id, id)`). */
  key: string;
  /** The path the file has after the merge (the target's, unless the source renamed it). */
  path: string;
  /** The target's path, if the merge renames the file. */
  was?: string;
  status: MergeStatus;
  /** Only the name changes (taken from the source, or kept). */
  renamed?: { from: string; to: string; side: 'ours' | 'theirs' };
  /**
   * Where the file's content comes from after the merge: the target's own (`ours`, nothing to
   * write unless the name changes), the source's (`theirs`), the clean merge (`merged`, in
   * `text`), or what is decided (`conflict`). A removed file has none.
   */
  content: 'ours' | 'theirs' | 'merged' | 'conflict' | 'none';
  /** The merged text, for `merged`. */
  text?: string;
  /** For a text file with conflicts: the merge with the chunks, to settle with `settleFile`. */
  merge?: MergeResult;
  conflicts: PlanConflict[];
  /** The file in the target as the plan saw it, or null if the target has none. */
  target: TargetFile | null;
  /** The file in the source, or null. */
  source: { fileId: string; path: string; digest: string } | null;
  /** The file in the base, or null. */
  base: { fileId: string; path: string; digest: string } | null;
  /**
   * Applying the plan writes this file (its text or bytes, name, creation or deletion), so the
   * file must still stand in the target as `target` says.
   */
  touches: boolean;
};

export type SettingPlan = {
  status: 'unchanged' | 'kept' | 'taken' | 'conflict';
  base: string | null;
  ours: string | null;
  theirs: string | null;
};

export type MergePlan = {
  target: {
    paper: string;
    revision: string;
    number: number;
    /**
     * Every file of the target in that revision, with the place in its edit log (`headSeq`) the
     * revision captured. To refuse a stale merge, `applyMerge` holds the target's files and
     * compares each `touches` file's `head_seq` with `headSeq` here, and the file set and paths
     * with `files`: a different `head_seq`, a file gone or new, or another path means the paper
     * changed after the plan, and the merge is refused (a restore would re-make its edits; a
     * merge decided by a person does not).
     */
    files: TargetFile[];
  };
  source: { paper: string; revision: string; number: number };
  base: { revision: string; number: number };
  /** Every file that is in the target or the source, by path; files gone from both are left out. */
  files: PlannedFile[];
  /** Every decision needed, in the order of the files' paths, ready for one card each. */
  conflicts: PlanConflict[];
  settings: { root: SettingPlan; compiler: SettingPlan };
  counts: Record<MergeStatus, number> & { conflicts: number };
};

const SIDES: ChoiceName[] = ['ours', 'theirs'];

function setting(base: string | null, ours: string | null, theirs: string | null): SettingPlan {
  const status =
    ours === theirs ? 'unchanged' : theirs === base ? 'kept' : ours === base ? 'taken' : 'conflict';
  return { status, base, ours, theirs };
}

/** Text of the file, or null if it is not editable text or is over the size the plan reads. */
async function textOf(store: BlobStore, digest: string): Promise<string | null | 'big'> {
  const size = await store.size(digest);
  if (size !== null && size > WHOLE_FILE_BYTES) return 'big';
  const d = decodeFile(await blob(store, digest));
  return d.editable ? d.text : null;
}

/**
 * The plan from three revisions of one family: a pure function of them and their bytes, so the
 * same three give the same plan (and the same conflict IDs) whenever it is asked for. No check of
 * who asks; `planMerge` does that. `ours` is the target's revision, `theirs` the source's.
 */
export async function planFromRevisions(
  db: Db,
  store: BlobStore,
  revisions: { target: string; source: string; base: string },
): Promise<MergePlan> {
  const [o, t, b] = await Promise.all([
    loadByOrigin(db, revisions.target),
    loadByOrigin(db, revisions.source),
    loadByOrigin(db, revisions.base),
  ]);
  const O = new Map(o.files.map((f) => [f.key, f]));
  const T = new Map(t.files.map((f) => [f.key, f]));
  const B = new Map(b.files.map((f) => [f.key, f]));
  // Two files made new at one path on the two sides, outside the base, are one pair: the same
  // bytes are the same file, and different bytes are two texts to merge from nothing.
  const onlyO = new Map([...O].filter(([k]) => !T.has(k) && !B.has(k)).map(([, f]) => [f.path, f]));
  for (const [k, f] of [...T]) {
    const mate = !O.has(k) && !B.has(k) ? onlyO.get(f.path) : undefined;
    if (!mate) continue;
    T.delete(k);
    T.set(mate.key, { ...f, key: mate.key });
  }
  const keys = [...new Set([...O.keys(), ...T.keys()])];

  const files: PlannedFile[] = [];
  for (const key of keys) {
    const ours = O.get(key) ?? null;
    const theirs = T.get(key) ?? null;
    const base = B.get(key) ?? null;
    const planned = await planFile(store, key, ours, theirs, base);
    files.push(planned);
  }

  // A file the merge would put at a path another file of the target keeps is a decision, not a
  // silent overwrite.
  const staying = new Map<string, string>();
  for (const f of files)
    if (f.status !== 'removed' && !(f.status === 'added' || (f.status === 'taken' && f.was)))
      staying.set(f.was ?? f.path, f.key);
  for (const f of files) {
    const moving = f.status === 'added' || (f.status === 'taken' && f.was);
    const other = staying.get(f.path);
    if (!moving || !other || other === f.key) continue;
    f.status = 'conflict';
    f.content = 'conflict';
    f.conflicts = [
      {
        id: f.key,
        key: f.key,
        path: f.path,
        kind: 'path-taken',
        oursFile: null,
        theirsFile: f.source && { path: f.source.path, digest: f.source.digest },
        choices: [...SIDES],
      },
    ];
  }

  files.sort((p, q) => p.path.localeCompare(q.path) || p.key.localeCompare(q.key));
  const conflicts = files.flatMap((f) => f.conflicts);
  const counts = {
    unchanged: 0,
    kept: 0,
    taken: 0,
    merged: 0,
    added: 0,
    removed: 0,
    conflict: 0,
    conflicts: conflicts.length,
  };
  for (const f of files) counts[f.status]++;
  return {
    target: {
      paper: o.paper,
      revision: revisions.target,
      number: o.number,
      files: o.files.map((f) => ({ fileId: f.fileId, path: f.path, headSeq: f.seq })),
    },
    source: { paper: t.paper, revision: revisions.source, number: t.number },
    base: { revision: revisions.base, number: b.number },
    files,
    conflicts,
    settings: {
      root: setting(b.root, o.root, t.root),
      compiler: setting(b.compiler, o.compiler, t.compiler),
    },
    counts,
  };
}

const side = (e: Entry | null) => e && { fileId: e.fileId, path: e.path, digest: e.digest };

async function planFile(
  store: BlobStore,
  key: string,
  ours: Entry | null,
  theirs: Entry | null,
  base: Entry | null,
): Promise<PlannedFile> {
  const out: PlannedFile = {
    key,
    path: (ours ?? theirs)!.path,
    status: 'unchanged',
    content: ours ? 'ours' : 'theirs',
    conflicts: [],
    target: ours && { fileId: ours.fileId, path: ours.path, headSeq: ours.seq },
    source: side(theirs),
    base: side(base),
    touches: false,
  };
  const conflict = (c: Omit<PlanConflict, 'id' | 'key' | 'path'>) => {
    out.status = 'conflict';
    out.content = 'conflict';
    out.touches = true;
    out.conflicts = [{ id: key, key, path: out.path, ...c }];
    return out;
  };
  const fileOf = (e: Entry | null) => (e ? { path: e.path, digest: e.digest } : null);

  if (!ours && !theirs) return out; // not reached: keys come from the two sides
  if (!base) {
    if (ours && !theirs) return { ...out, status: 'kept' };
    if (!ours && theirs) return { ...out, path: theirs.path, status: 'added', touches: true };
  }
  if (base && !ours && theirs) {
    // Deleted in the target. Untouched in the source: stays deleted. Changed there: a decision.
    if (theirs.digest === base.digest)
      return { ...out, path: theirs.path, status: 'kept', content: 'none' };
    return conflict({
      kind: 'deleted-vs-changed',
      oursFile: null,
      theirsFile: fileOf(theirs),
      choices: [...SIDES],
    });
  }
  if (base && ours && !theirs) {
    if (ours.digest === base.digest)
      return { ...out, status: 'removed', content: 'none', touches: true };
    return conflict({
      kind: 'deleted-vs-changed',
      oursFile: fileOf(ours),
      theirsFile: null,
      choices: [...SIDES],
    });
  }

  // On both sides. The name first: a rename on one side is taken, on both ways it is a decision.
  const o = ours!;
  const t = theirs!;
  const baseName = base?.path ?? null;
  let name = o.path;
  if (o.path !== t.path) {
    if (t.path === baseName) name = o.path;
    else if (o.path === baseName) {
      name = t.path;
      out.was = o.path;
      out.renamed = { from: o.path, to: t.path, side: 'theirs' };
    } else {
      out.path = o.path;
      return conflict({
        kind: 'renamed',
        oursFile: fileOf(o),
        theirsFile: fileOf(t),
        choices: [...SIDES],
      });
    }
  } else if (baseName && o.path !== baseName)
    out.renamed = { from: baseName, to: o.path, side: 'ours' };
  out.path = name;

  const renameTaken = out.renamed?.side === 'theirs';
  const same = o.digest === t.digest;
  if (same || (base && t.digest === base.digest)) {
    // The text stands as the target has it; only a name taken from the source changes anything.
    out.status = renameTaken ? 'taken' : same && !out.renamed ? 'unchanged' : 'kept';
    out.touches = renameTaken;
    return out;
  }
  if (base && o.digest === base.digest) {
    out.status = 'taken';
    out.content = 'theirs';
    out.touches = true;
    return out;
  }

  // The content changed on both sides (or there is no base: two files made new at one path).
  const [bt, ot, tt] = await Promise.all([
    base ? textOf(store, base.digest) : '',
    textOf(store, o.digest),
    textOf(store, t.digest),
  ]);
  if (bt === null || ot === null || tt === null)
    return conflict({
      kind: 'binary',
      oursFile: fileOf(o),
      theirsFile: fileOf(t),
      choices: [...SIDES],
    });
  if (bt === 'big' || ot === 'big' || tt === 'big')
    return conflict({
      kind: 'text',
      textKind: 'too-large',
      oursFile: fileOf(o),
      theirsFile: fileOf(t),
      choices: [...SIDES],
    });
  const merge = merge3(bt, ot, tt);
  if (!merge.conflicts.length) {
    out.status = 'merged';
    out.content = 'merged';
    out.touches = true;
    out.text = merge.text;
    return out;
  }
  out.status = 'conflict';
  out.content = 'conflict';
  out.touches = true;
  out.merge = merge;
  out.conflicts = merge.conflicts.map((c, i) => ({
    id: `${key}#${i + 1}`,
    key,
    path: out.path,
    kind: 'text' as const,
    textKind: c.kind,
    line: c.line,
    base: c.base,
    ours: c.ours,
    theirs: c.theirs,
    offsets: {
      base: [c.baseStart, c.baseEnd],
      ours: [c.oursStart, c.oursEnd],
      theirs: [c.theirsStart, c.theirsEnd],
      merged: c.textStart,
    },
    // A text that was too large to compare is one conflict on the whole file: a side, or by hand.
    choices:
      c.kind === 'too-large'
        ? ['ours', 'theirs', 'text']
        : ['ours', 'theirs', 'both', 'base', 'text'],
  }));
  return out;
}

/**
 * The text of a file with conflicts, each settled by the choice made for its ID (a side, both, or
 * text written by hand). For T36's apply; throws if a conflict has no choice.
 */
export function settleFile(file: PlannedFile, choices: Record<string, MergeChoice>): string {
  if (!file.merge) throw new Error('This file has no text conflicts.');
  return resolveChoices(file.merge, file.conflicts, choices);
}

function resolveChoices(
  merge: MergeResult,
  conflicts: PlanConflict[],
  choices: Record<string, MergeChoice>,
): string {
  return resolveMerge(
    merge,
    conflicts.map((c) => {
      const choice = choices[c.id];
      if (!choice) throw new Error(`No choice for ${c.id}.`);
      return choice;
    }),
  );
}

/**
 * The plan for merging `sourcePaper` into `targetPaper`, one of which is a version of the other
 * (either way round: a version into main, or main into the version to bring it up to date). Both
 * are cut as revisions first, so the plan is of fixed revisions the page can name again. Owners and
 * editors only, as a restore is; for anyone else on the papers, `permission_denied`, and for
 * outsiders `not_found`. The common base is the version's `base_revision_id`.
 */
export async function planMerge(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  targetPaper: string,
  sourcePaper: string,
): Promise<MergePlan> {
  const [target, source] = await members(
    pool,
    userId,
    [targetPaper, sourcePaper],
    'revision.write',
  );
  const version = versionOf(target, source);
  const baseRow = (
    await pool.query('select base_revision_id from projects where id = $1', [version.id])
  ).rows[0];
  if (!baseRow?.base_revision_id) throw noBase();
  const ours = await cutRevision(pool, store, userId, target.id);
  const theirs = await cutRevision(pool, store, userId, source.id);
  return planFromRevisions(pool, store, {
    target: ours.id,
    source: theirs.id,
    base: baseRow.base_revision_id,
  });
}
