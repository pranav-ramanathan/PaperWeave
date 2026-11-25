// Revisions: the paper frozen at a moment. Cutting, naming, comparing, restoring and exporting.
import { createHash } from 'node:crypto';
import { LATEXMK_RULES, bblFormat, decodeFile } from '@paperweave/latex';
import type pg from 'pg';
import {
  checkPath,
  nfc,
  clashMessage,
  type Entry,
  pathClash,
  texName,
  writeZip,
  zipStream,
} from './archive.ts';
import { mapLimit, READ_BYTES, READS, readAhead } from './batch.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { fileMeta, filesChanged, removeFile } from './files.ts';
import { chargeRewrite, mayRewrite, type RewriteOpts } from './limits.ts';
import { recordDownload } from './metrics.ts';
import { id } from './projects.ts';
import * as Y from 'yjs';
import {
  appendUpdates,
  bytesOfLog,
  compactIfDue,
  currentBytes,
  editLocked,
  notifyEdits,
  openFile,
  readLogs,
  TEXT,
} from './sync.ts';
import { type DiffLine, diffLinesFar, diffWords, FAR_EDITS, wholeFile } from './textdiff.ts';

export type Revision = {
  id: string;
  number: number;
  name: string | null;
  kind: 'auto' | 'named' | 'restore';
  createdAt: string;
  createdBy: string | null;
  /** The number of the revision this one restored, if it is a restore. */
  restoredFrom: number | null;
  hasPdf: boolean;
  /** What changed against the revision before; null until it has been counted (`revisionStats`). */
  stat?: RevisionStat | null;
};

/**
 * What changed in a revision against the one before it (the first: against nothing). Words are
 * those of the text files that changed; a file that is not text counts as a changed file and as
 * no words. `partial` means some text was too large to compare, so the words are a lower bound.
 */
export type RevisionStat = { files: number; added: number; removed: number; partial?: true };
type RevisionFile = { file_id: string; path: string; digest: string };

/**
 * Freeze the paper as it is now. An automatic cut that finds nothing changed since the latest
 * revision returns that one. No permission check here: callers that act for a person check first.
 */
export async function cutRevision(
  pool: pg.Pool,
  store: BlobStore,
  userId: string | null,
  projectId: string,
  opts: {
    name?: string;
    kind?: Revision['kind'];
    restoredFrom?: string;
    /**
     * More to do in the same transaction, after the cut and with every file still held: the
     * cut and this happen together or not at all. It runs when the cut found nothing changed, too.
     */
    within?: (db: Db) => Promise<void>;
  } = {},
): Promise<{ id: string; number: number }> {
  const { within, ...rest } = opts;
  const ready = await putEdited(pool, store, projectId);
  const made = await transaction(pool, async (db) => {
    const made = await cut(db, store, userId, projectId, { ...rest, ready });
    await within?.(db);
    return made;
  });
  // Counted once the paper is free again: the files are not held while their text is compared.
  // A cut never fails for it: what is not counted here is counted when asked for.
  await countRevisions(pool, store, projectId, [made.id]).catch(() => undefined);
  return made;
}

/** What a file's text was stored as, and the place in its log that was the text of. */
type Ready = Map<string, { seq: string; digest: string; size: number }>;

/**
 * Store every edited file's text as it is now, ahead of a cut and without holding anything.
 * A cut holds back every edit to the paper while it reads the files. Sending their text to the
 * store inside that hold would make everyone's editing wait on the store; done here first, the
 * cut only has to send again what was edited in the moment between.
 */
async function putEdited(pool: pg.Pool, store: BlobStore, projectId: string): Promise<Ready> {
  // Each file's place in its log is read before its log is. An edit landing between the two
  // leaves a place that is already out of date, which the cut sees and does not trust.
  const { rows } = await pool.query(
    `select id, digest, eol, bom, head_seq from files
     where project_id = $1 and eol is not null and head_seq > 1`,
    [projectId],
  );
  // The logs of all of them come in one statement, and the store is sent sixteen at a time. The
  // database and the store may be far away: one file after another, each is a wait of its own.
  const logs = await readLogs(
    pool,
    rows.map((f) => f.id),
  );
  const bytes = rows.map((f) => bytesOfLog(f, logs.get(f.id) ?? []));
  const digests = await mapLimit(bytes, READS, (b) => store.put(b));
  const ready: Ready = new Map();
  rows.forEach((f, i) =>
    ready.set(f.id, { seq: String(f.head_seq), digest: digests[i], size: bytes[i].length }),
  );
  return ready;
}

/** The same as one step of a larger transaction. */
async function cut(
  db: Db,
  store: BlobStore,
  userId: string | null,
  projectId: string,
  opts: { name?: string; kind?: Revision['kind']; restoredFrom?: string; ready?: Ready } = {},
): Promise<{ id: string; number: number }> {
  const kind = opts.kind ?? 'auto';
  {
    // Locking the file rows holds back new edits for the moment it takes to read them, so every
    // file is captured at the same point. It also keeps two cuts from running at once.
    const files = (
      await db.query(
        `select id, path, digest, eol, bom, head_seq from files where project_id = $1
         order by path for update`,
        [projectId],
      )
    ).rows;
    const project = (
      await db.query(
        `select p.compiler, r.path as root from projects p
         left join files r on r.id = p.root_file_id where p.id = $1`,
        [projectId],
      )
    ).rows[0];
    if (!project) throw new AppError('not_found', 'No such project.');
    const captured: { id: string; path: string; digest: string; seq: string }[] = [];
    const sized: { id: string; size: number }[] = [];
    for (const f of files) {
      const edited = f.eol && Number(f.head_seq) > 1;
      if (!edited) {
        captured.push({ id: f.id, path: f.path, digest: f.digest, seq: f.head_seq });
        continue;
      }
      // Stored already, unless it has been edited since.
      let had = opts.ready?.get(f.id);
      if (had?.seq !== String(f.head_seq)) {
        const bytes = await currentBytes(db, store, f);
        had = { seq: String(f.head_seq), digest: await store.put(bytes), size: bytes.length };
      }
      captured.push({ id: f.id, path: f.path, digest: had.digest, seq: f.head_seq });
      sized.push({ id: f.id, size: had.size });
    }
    // How large each edited file now is, for the paper's page and for what a paper may hold.
    // Otherwise a file would go on saying the size it was added with: nothing, for one started
    // blank and written here. It is known at this moment and at no cheaper one.
    await db.query(
      `update files f set size = c.size from unnest($1::uuid[], $2::int[]) as c(id, size)
       where f.id = c.id and f.size <> c.size`,
      [sized.map((x) => x.id), sized.map((x) => x.size)],
    );
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          files: captured.map((c) => [c.path, c.digest]),
          root: project.root,
          compiler: project.compiler,
        }),
      )
      .digest('hex');
    const last = (
      await db.query(
        'select id, number, content_key, kind, name, restored_from from revisions where project_id = $1 order by number desc limit 1',
        [projectId],
      )
    ).rows[0];
    // Saved again under the name it was just saved under, or put back again to the revision
    // it was just put back to, with nothing changed: a button pressed twice. That is the
    // revision there already, not a second one like it.
    const again =
      (kind === 'named' && last?.kind === 'named' && last.name === opts.name) ||
      (kind === 'restore' && last?.kind === 'restore' && last.restored_from === opts.restoredFrom);
    if ((kind === 'auto' || again) && last?.content_key === key) {
      // The same text as the latest revision, though the logs may have moved on: a file opened
      // for the first time, something typed and taken back. The revision is this text too, so
      // it is told where the logs now stand. Otherwise a build of it would look behind the
      // text for ever, and be asked for again and again.
      const same = await db.query(
        `update revision_files rf set seq = c.seq
         from unnest($2::uuid[], $3::text[], $4::bigint[]) as c(id, path, seq)
         where rf.revision_id = $1 and rf.file_id = c.id and rf.path = c.path`,
        [
          last.id,
          captured.map((c) => c.id),
          captured.map((c) => c.path),
          captured.map((c) => c.seq),
        ],
      );
      // Unless a file was deleted and made again under its name: that is another file, and
      // gets a revision that says so.
      if (same.rowCount === captured.length) return { id: last.id, number: last.number };
    }
    const made = (
      await db.query(
        `insert into revisions (project_id, number, name, kind, restored_from, root, compiler, content_key, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, number`,
        [
          projectId,
          (last?.number ?? 0) + 1,
          opts.name ?? null,
          kind,
          opts.restoredFrom ?? null,
          project.root,
          project.compiler,
          key,
          userId,
        ],
      )
    ).rows[0];
    await db.query(
      `insert into revision_files (revision_id, file_id, path, digest, seq)
       select $1, * from unnest($2::uuid[], $3::text[], $4::text[], $5::bigint[])`,
      [
        made.id,
        captured.map((c) => c.id),
        captured.map((c) => c.path),
        captured.map((c) => c.digest),
        captured.map((c) => c.seq),
      ],
    );
    return made;
  }
}

/** Save the paper as it is now under a name. */
export async function saveRevision(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  name: unknown,
) {
  await authorize(pool, userId, id(projectId), 'revision.write');
  return cutRevision(pool, store, userId, projectId, { name: revisionName(name), kind: 'named' });
}

/** A revision's name, trimmed, or `invalid_input`. */
function revisionName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 200)
    throw new AppError('invalid_input', 'A revision needs a name of at most 200 characters.');
  return name.trim();
}

/**
 * Give a revision that exists a name, or another one. An automatic revision that is named
 * becomes a named one (and is listed from then on); a restore keeps being one. The revision's
 * content is not touched. For those who may save a revision.
 */
export async function nameRevision(
  db: Db,
  userId: string,
  projectId: string,
  revisionId: string,
  name: unknown,
): Promise<{ id: string; number: number; name: string; kind: Revision['kind'] }> {
  await authorize(db, userId, id(projectId), 'revision.write');
  const given = revisionName(name);
  const { rows } = await db.query(
    `update revisions set name = $3, kind = case when kind = 'auto' then 'named' else kind end
     where id = $1 and project_id = $2 returning id, number, name, kind`,
    [id(revisionId), projectId, given],
  );
  if (!rows[0]) throw new AppError('not_found', 'No such revision.');
  return rows[0];
}

/**
 * The paper as it is now, as a revision, to compare an earlier one with: the latest revision if
 * nothing has changed since it was made, otherwise a new automatic one. For those who may make
 * revisions; others compare with the latest there is.
 */
export async function revisionOfNow(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
) {
  await authorize(pool, userId, id(projectId), 'revision.write');
  return cutRevision(pool, store, userId, projectId);
}

/** How many automatic revisions a list shows at once. A paper being written gets one at every build. */
export const REVISIONS_SHOWN = 50;

/**
 * A paper's revisions, newest first: every one that a person named and every restore, and the
 * newest `autos` automatic ones (all of them, if not given). With `before`, only revisions with
 * a lower number, which is how the older ones are reached.
 */
export async function listRevisions(
  db: Db,
  userId: string,
  projectId: string,
  opts: { autos?: number; before?: number } = {},
): Promise<Revision[]> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select r.id, r.number, r.name, r.kind, r.created_at as "createdAt", u.email as "createdBy",
            f.number as "restoredFrom",
            exists (select 1 from builds b where b.revision_id = r.id and b.pdf_digest is not null) as "hasPdf",
            r.stat
     from revisions r left join "user" u on u.id = r.created_by
     left join revisions f on f.id = r.restored_from
     where r.project_id = $1 and ($2::int is null or r.number < $2)
       and (r.kind <> 'auto' or $3::int is null or r.number in (
         select number from revisions where project_id = $1 and kind = 'auto'
           and ($2::int is null or number < $2) order by number desc limit $3
       ))
     order by r.number desc`,
    [projectId, opts.before ?? null, opts.autos ?? null],
  );
  return rows;
}

/** How many automatic revisions a paper has with a number below `before`. */
export async function olderAutoRevisions(
  db: Db,
  userId: string,
  projectId: string,
  before: number,
): Promise<number> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    "select count(*)::int as n from revisions where project_id = $1 and kind = 'auto' and number < $2",
    [projectId, before],
  );
  return rows[0].n;
}

/** A revision of this paper and its files, or `not_found`. */
async function load(db: Db, projectId: string, revisionId: string) {
  const revision = (
    await db.query(
      `select r.id, r.number, r.root, r.compiler, r.created_at, p.name as paper
       from revisions r join projects p on p.id = r.project_id where r.id = $1 and r.project_id = $2`,
      [id(revisionId), projectId],
    )
  ).rows[0];
  if (!revision) throw new AppError('not_found', 'No such revision.');
  const files: RevisionFile[] = (
    await db.query(
      'select file_id, path, digest from revision_files where revision_id = $1 order by path',
      [revisionId],
    )
  ).rows;
  return { revision, files };
}

/** The types of file the ZIP of only the files the paper uses may leave out. */
const LEFT_OUT = /\.(?:tex|ltx|pdf|png|jpe?g|eps)$/i;

/**
 * Of these files (never the held ones), those the revision's newest succeeded build never
 * opened: not read, not the root, and of a type that can be left out. `null` if the revision has
 * no succeeded build; none if that build did not record what it read (an older one). Also the
 * digest of the .bbl that same build read, if it kept one.
 */
async function unusedPaths(
  db: Db,
  projectId: string,
  revisionId: string,
  root: string | null,
  files: RevisionFile[],
): Promise<{ paths: string[]; bbl: string | null } | null> {
  const built = (
    await db.query(
      `select read, bbl_digest from builds
       where revision_id = $1 and project_id = $2 and status = 'succeeded'
       order by created_at desc limit 1`,
      [revisionId, projectId],
    )
  ).rows[0];
  if (!built) return null;
  const bbl: string | null = built.bbl_digest ?? null;
  if (!Array.isArray(built.read)) return { paths: [], bbl };
  const read = new Set<string>(
    (built.read as unknown[]).flatMap((p) => (typeof p === 'string' ? [p.normalize('NFC')] : [])),
  );
  return {
    paths: files
      .filter((f) => f.path !== root && LEFT_OUT.test(f.path) && !read.has(f.path.normalize('NFC')))
      .map((f) => f.path),
    bbl,
  };
}

/**
 * The .bbl a build made for the paper: where the ZIP of only the files the paper uses puts it
 * (beside the root, named for it), its digest, and the digest of the revision's own file at that
 * path, if it has one. The revision's own file is never replaced.
 */
export type BuiltBbl = { path: string; digest: string; own: string | null };

/** The .bbl `unusedPaths` found, placed beside the root. None where the root cannot name one. */
function placeBbl(
  root: string | null,
  digest: string | null,
  files: RevisionFile[],
): BuiltBbl | null {
  if (!digest || !root || !/\.(tex|ltx)$/i.test(root)) return null;
  const path = root.replace(/\.(tex|ltx)$/i, '.bbl').normalize('NFC');
  const own = files.find((f) => f.path.normalize('NFC') === path);
  // A folder of that name stands in the way: the archive could not hold both.
  if (
    !own &&
    pathClash(
      path,
      files.map((f) => f.path),
    )
  )
    return null;
  return { path, digest, own: own?.digest ?? null };
}

/** The biblatex format version of a .bbl's bytes, or null for a BibTeX one (see `bblFormat`). */
export const formatOfBbl = (bytes: Uint8Array) =>
  bblFormat(new TextDecoder('utf-8').decode(bytes.subarray(0, 2000)));

/**
 * The .bbl of the revision's newest succeeded build, as the ZIP of only the files the paper uses
 * holds or would add it; null if there is none.
 */
export async function bblInRevision(
  db: Db,
  userId: string,
  projectId: string,
  revisionId: string,
): Promise<BuiltBbl | null> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { revision, files } = await load(db, projectId, revisionId);
  const found = await unusedPaths(db, projectId, revisionId, revision.root, []);
  return found ? placeBbl(revision.root, found.bbl, files) : null;
}

/**
 * The files of a revision, not held back from downloads, that its newest succeeded build never
 * opened, as the ZIP of only the files the paper uses leaves them out. None when it has not
 * been built, or the build did not record what it read.
 */
export async function unusedInRevision(
  db: Db,
  userId: string,
  projectId: string,
  revisionId: string,
): Promise<string[]> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { revision, files } = await load(db, projectId, revisionId);
  const held = await heldFileIds(db, projectId);
  return (
    (
      await unusedPaths(
        db,
        projectId,
        revisionId,
        revision.root,
        files.filter((f) => !held.has(f.file_id)),
      )
    )?.paths ?? []
  );
}

/** The files whose authors keep them out of downloads: data not marked to be included. */
export async function heldFileIds(db: Db, projectId: string): Promise<Set<string>> {
  return new Set(
    (
      await db.query('select file_id from datasets where project_id = $1 and not exported', [
        projectId,
      ])
    ).rows.map((r) => r.file_id),
  );
}

/** The paths, now, of the files a download of the paper as it is leaves out. */
export async function heldNow(db: Db, userId: string, projectId: string): Promise<string[]> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select f.path from datasets d join files f on f.id = d.file_id
     where d.project_id = $1 and not d.exported order by f.path`,
    [projectId],
  );
  return rows.map((r) => r.path);
}

/** For each revision, the paths in it that its ZIP leaves out. A revision with none is absent. */
export async function heldInRevisions(
  db: Db,
  userId: string,
  projectId: string,
  revisionIds: string[],
): Promise<Map<string, string[]>> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select rf.revision_id, rf.path from revision_files rf
     join datasets d on d.file_id = rf.file_id and d.project_id = $1 and not d.exported
     where rf.revision_id = any($2::uuid[]) order by rf.path`,
    [projectId, revisionIds],
  );
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.revision_id, [...(out.get(r.revision_id) ?? []), r.path]);
  return out;
}

/** What a revision's downloads are named after: the paper's name, and the revision's number. */
export async function revisionTitle(
  db: Db,
  userId: string,
  projectId: string,
  revisionId: string,
): Promise<{ paper: string; number: number }> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { revision } = await load(db, projectId, revisionId);
  return { paper: revision.paper, number: revision.number };
}

const blob = async (store: BlobStore, digest: string) => {
  const bytes = await store.get(digest);
  if (!bytes) throw new Error(`blob ${digest} is missing`);
  return bytes;
};

/**
 * A revision's files as a ZIP. With `manifest`, the archive also says how it was built, so the
 * same PDF can be made again outside PaperWeave.
 */
export async function exportRevision(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  revisionId: string,
  manifest = false,
  /** More to put in the archive beside the paper's files. */
  extra: Entry[] = [],
  /** Only the files the last good build opened (and those it cannot tell about). */
  used = false,
): Promise<{ zip: Uint8Array; paper: string; number: number }> {
  const { shared, rest, paper, number } = await revisionEntries(
    db,
    store,
    userId,
    projectId,
    revisionId,
    manifest,
    extra,
    used,
  );
  // Sixteen blobs at a time, and the entries in the order of the files.
  const bytes = await mapLimit(shared, READS, (f) => blob(store, f.digest));
  const entries = shared.map((f, i) => ({ path: f.path, bytes: bytes[i] }));
  return { zip: await writeZip([...entries, ...rest]), paper, number };
}

/** The same archive, as a stream, for a response that may be larger than a function may send whole. */
export async function exportRevisionStream(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  revisionId: string,
  manifest = false,
  extra: Entry[] = [],
  used = false,
): Promise<{ zip: ReadableStream<Uint8Array>; paper: string; number: number }> {
  const { shared, rest, paper, number } = await revisionEntries(
    db,
    store,
    userId,
    projectId,
    revisionId,
    manifest,
    extra,
    used,
  );
  // Each file is added as its blob arrives, in the order of the files, with up to sixteen being
  // read ahead of the one being added, and no more than READ_BYTES of them. A revision does not
  // keep its files' sizes, so the store is asked (nothing is read) before the first blob is.
  async function* entries(): AsyncGenerator<Entry> {
    const sizes = await mapLimit(shared, READS, (f) => store.size(f.digest));
    const sized = shared.map((f, i) => ({ ...f, size: sizes[i] ?? 0 }));
    yield* readAhead(
      sized,
      READS,
      async (f) => ({ path: f.path, bytes: await blob(store, f.digest) }),
      { weight: (f) => f.size, budget: READ_BYTES },
    );
    yield* rest;
  }
  return { zip: zipStream(entries()), paper, number };
}

/** What goes into a revision's archive: the files, whose bytes are still to be read, and the rest. */
async function revisionEntries(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  revisionId: string,
  manifest = false,
  /** More to put in the archive beside the paper's files. */
  extra: Entry[] = [],
  /**
   * Leave out the files the revision's last good build never opened (see `unusedPaths`), and
   * add the .bbl that build read, if the revision has no file of that name.
   */
  used = false,
): Promise<{
  shared: { path: string; digest: string }[];
  rest: Entry[];
  paper: string;
  number: number;
}> {
  await authorize(db, userId, id(projectId), 'project.export');
  const { revision, files } = await load(db, projectId, revisionId);
  // Data goes into a download only if its author has said so. A CSV file nobody has described
  // as data is a file like any other. The hold is by file, whichever revision is downloaded.
  const held = await heldFileIds(db, projectId);
  let shared = files.filter((f) => !held.has(f.file_id));
  const kept = files.filter((f) => held.has(f.file_id));
  let unused: string[] = [];
  // The .bbl the build made, when the archive gets it (the revision has no file of that name).
  let added: BuiltBbl | null = null;
  if (used) {
    const found = await unusedPaths(db, projectId, revisionId, revision.root, shared);
    if (!found) throw new AppError('not_found', 'This revision has not been built.');
    unused = found.paths;
    const gone = new Set(unused);
    shared = shared.filter((f) => !gone.has(f.path));
    const bbl = placeBbl(revision.root, found.bbl, files);
    if (bbl && !bbl.own) added = bbl;
  }
  const rest: Entry[] = [];
  if (manifest) {
    const built = (
      await db.query(
        `select image from builds where revision_id = $1 and pdf_digest is not null
         order by created_at desc limit 1`,
        [revisionId],
      )
    ).rows[0];
    // Where each drawn chart among the files came from: which data, which version of it, what
    // was drawn and with what. Found by the file's bytes, so it is right for this revision.
    const drawn = (
      await db.query(
        `select pdf_digest, png_digest, record from chart_draws
         where project_id = $1 and (pdf_digest = any($2) or png_digest = any($2)) order by id`,
        [projectId, shared.map((f) => f.digest)],
      )
    ).rows;
    const charts = Object.fromEntries(
      shared.flatMap((f) => {
        const from = drawn.findLast((d) => d.pdf_digest === f.digest || d.png_digest === f.digest);
        if (!from) return [];
        // The chart's data may be among the files held back: it is named all the same, and
        // marked, so that its absence from the archive is seen to be on purpose.
        const data = from.record.data;
        const away = kept.some(
          (k) => k.path === data?.path || `sha256:${k.digest}` === data?.sha256,
        );
        return [[f.path, away ? { ...from.record, data: { ...data, held: true } } : from.record]];
      }),
    );
    // The PDF is stamped with the moment of the revision whose build made it. A build whose
    // inputs were built before is not made again: it takes that build's PDF (itself maybe
    // taken from an earlier one), so the stamp is the time of the first revision that was built.
    const stamped = (
      await db.query(
        `with recursive chain as (
           (select id, revision_id, cached_from from builds
            where revision_id = $1 and pdf_digest is not null order by created_at desc limit 1)
           union all
           select b.id, b.revision_id, b.cached_from
           from builds b join chain c on b.id = c.cached_from
         )
         select r.created_at from chain c join revisions r on r.id = c.revision_id
         where c.cached_from is null`,
        [revisionId],
      )
    ).rows[0]?.created_at;
    const epoch = Math.floor(new Date(stamped ?? revision.created_at).getTime() / 1000);
    const engine = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }[
      revision.compiler as string
    ];
    const text = JSON.stringify(
      {
        paper: revision.paper,
        revision: revision.number,
        root: revision.root,
        compiler: revision.compiler,
        // The toolchain image the PDF was built with, if this revision has been built.
        image: built?.image ?? null,
        // PDF timestamps are set from this, so a rebuild gives the same bytes.
        sourceDateEpoch: epoch,
        command: `SOURCE_DATE_EPOCH=${epoch} FORCE_SOURCE_DATE=1 latexmk -norc -cd ${engine} -no-shell-escape -bibtex-cond -interaction=nonstopmode -e '${LATEXMK_RULES}' ${shellPath(revision.root)}`,
        files: Object.fromEntries(shared.map((f) => [f.path, `sha256:${f.digest}`])),
        charts,
        // Data files left out of this archive on purpose: their authors keep them back.
        held: kept.map((f) => f.path),
        // Files this archive leaves out because the build never opened them (`?used` only).
        ...(used ? { unused } : {}),
        // The .bbl this archive adds, for a venue that runs neither BibTeX nor Biber. `format`
        // is the biblatex version a Biber .bbl is for, and null for a BibTeX one.
        ...(added
          ? {
              bbl: {
                path: added.path,
                sha256: `sha256:${added.digest}`,
                format: formatOfBbl(await blob(store, added.digest)),
              },
            }
          : {}),
      },
      null,
      2,
    );
    rest.push({ path: 'paperweave-toolchain.json', bytes: Buffer.from(text + '\n') });
  }
  await recordDownload(db, projectId, 'zip');
  return {
    shared: added ? [...shared, { path: added.path, digest: added.digest }] : shared,
    rest: [...rest, ...extra],
    paper: revision.paper,
    number: revision.number,
  };
}

/** The PDF built from exactly this revision, or `not_found` if it has not been built. */
export async function revisionPdf(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  revisionId: string,
): Promise<Uint8Array> {
  return blob(store, await revisionPdfDigest(db, userId, projectId, revisionId));
}

/** Which blob is that PDF. For a download that is sent from the store, not through the app. */
export async function revisionPdfDigest(
  db: Db,
  userId: string,
  projectId: string,
  revisionId: string,
): Promise<string> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select b.pdf_digest from builds b where b.revision_id = $1 and b.project_id = $2
       and b.pdf_digest is not null order by b.created_at desc limit 1`,
    [id(revisionId), projectId],
  );
  if (!rows[0]) throw new AppError('not_found', 'This revision has not been built.');
  await recordDownload(db, projectId, 'pdf');
  return rows[0].pdf_digest;
}

export type FileDiff = {
  path: string;
  /** The earlier path, if the file was renamed. */
  was?: string;
  status: 'added' | 'removed' | 'changed' | 'renamed';
  /**
   * Line by line: for text that changed, and for an added or removed file every line, as `+` or
   * `-`. Null for other files and for text too large to compare or to show.
   */
  lines: DiffLine[] | null;
  /**
   * The file is text, but too much of it changed to compare line by line here, or (added or
   * removed) it is too large to be read for this.
   */
  tooLarge?: true;
  /** An added or removed file has this many more lines than are shown. */
  more?: number;
  /** The file is data its authors keep out of downloads, so no ZIP holds it. */
  held?: true;
};

/** An added or removed file larger than this many bytes is not read for the comparison. */
export const WHOLE_FILE_BYTES = 1024 * 1024;
/** The most lines the comparison shows of all its added and removed files together. */
export const WHOLE_FILES_LINES = 10_000;

/** What was read of one blob for the comparison: its text, or why there is none. */
type Seen = {
  /** The text, if it is editable text and the comparison compares it. */
  text: string | null;
  /** Too large to read here: nothing was fetched. */
  big?: true;
  /** For a file that is on one side only: its lines, up to the most one file shows. */
  whole?: ReturnType<typeof wholeFile>;
};

/** What changed between two revisions of a paper. Files that did not change are left out. */
export async function diffRevisions(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  fromId: string,
  toId: string,
): Promise<{ from: number; to: number; files: FileDiff[] }> {
  await authorize(db, userId, id(projectId), 'project.read');
  const a = await load(db, projectId, fromId);
  const b = await load(db, projectId, toId);
  const before = new Map(a.files.map((o) => [o.file_id, o]));
  const after = new Set(b.files.map((f) => f.file_id));
  const gone = a.files.filter((o) => !after.has(o.file_id));
  const fresh = b.files.filter((f) => !before.has(f.file_id));
  // A file deleted and made again at its path is another file (a new ID), though to anyone
  // reading the comparison it is the one file, changed. Its two sides are compared like any.
  const goneAt = new Map(gone.map((o) => [o.path, o]));
  const swapped = fresh.flatMap((f) => {
    const o = goneAt.get(f.path);
    return o ? [{ old: o, now: f }] : [];
  });
  const swappedIds = new Set(swapped.flatMap((s) => [s.old.file_id, s.now.file_id]));
  const only = [
    ...fresh.filter((f) => !swappedIds.has(f.file_id)).map((file) => ({ file, op: '+' as const })),
    ...gone.filter((o) => !swappedIds.has(o.file_id)).map((file) => ({ file, op: '-' as const })),
  ].sort((p, q) => p.file.path.localeCompare(q.file.path));
  const held = only.length || swapped.length ? await heldFileIds(db, projectId) : new Set<string>();

  // Everything to be read is read first, sixteen at a time. The text of a file that changed;
  // for a file on one side only (or deleted and made again), the store is asked its size first,
  // and a file over a megabyte is not fetched at all.
  const wanted = new Map<string, { digest: string; mode: '+' | '-' | 'g' | 'c' }>();
  const want = (digest: string, mode: '+' | '-' | 'g' | 'c') =>
    wanted.set(mode + digest, { digest, mode });
  for (const f of b.files) {
    const old = before.get(f.file_id);
    if (old && old.digest !== f.digest) {
      want(old.digest, 'c');
      want(f.digest, 'c');
    }
  }
  for (const s of swapped)
    if (s.old.digest !== s.now.digest) {
      want(s.old.digest, 'g');
      want(s.now.digest, 'g');
    }
  for (const { file, op } of only) want(file.digest, op);
  const read = new Map<string, Seen>();
  await mapLimit([...wanted], READS, async ([key, { digest, mode }]) => {
    if (mode !== 'c') {
      const size = await store.size(digest);
      if (size !== null && size > WHOLE_FILE_BYTES) {
        read.set(key, { text: null, big: true });
        return;
      }
    }
    const d = decodeFile(await blob(store, digest));
    if (!d.editable) read.set(key, { text: null });
    else if (mode === '+' || mode === '-')
      read.set(key, { text: null, whole: wholeFile(d.text, mode, FAR_EDITS) });
    else read.set(key, { text: d.text });
  });
  const seen = (digest: string, mode: '+' | '-' | 'g' | 'c') =>
    read.get(mode + digest) ?? { text: null };
  const compare = (
    path: string,
    x: Seen,
    y: Seen,
    was?: string,
  ): FileDiff & { status: 'changed' } => {
    const lines = x.text != null && y.text != null ? diffLinesFar(x.text, y.text) : null;
    const big = x.big || y.big;
    return {
      path,
      was,
      status: 'changed',
      lines,
      ...(big || (x.text != null && y.text != null && !lines) ? { tooLarge: true as const } : {}),
    };
  };

  const files: FileDiff[] = [];
  for (const f of b.files) {
    const old = before.get(f.file_id);
    if (old && old.digest !== f.digest) {
      const was = old.path !== f.path ? old.path : undefined;
      files.push(compare(f.path, seen(old.digest, 'c'), seen(f.digest, 'c'), was));
    } else if (old && old.path !== f.path)
      files.push({ path: f.path, was: old.path, status: 'renamed', lines: null });
  }
  for (const s of swapped) {
    // The same bytes under the same name: nothing differs, whatever the file's ID.
    if (s.old.digest === s.now.digest) continue;
    const both = compare(s.now.path, seen(s.old.digest, 'g'), seen(s.now.digest, 'g'));
    if (held.has(s.old.file_id) || held.has(s.now.file_id)) both.held = true;
    files.push(both);
  }
  // At most so many lines in all, shown in the order of the files' paths.
  let left = WHOLE_FILES_LINES;
  for (const { file, op } of only) {
    const entry: FileDiff = {
      path: file.path,
      status: op === '+' ? 'added' : 'removed',
      lines: null,
    };
    if (held.has(file.file_id)) entry.held = true;
    const r = seen(file.digest, op);
    if (r.big) entry.tooLarge = true;
    else if (r.whole) {
      const shown = Math.min(r.whole.lines.length, left);
      left -= shown;
      entry.lines = r.whole.lines.slice(0, shown);
      const more = r.whole.more + r.whole.lines.length - shown;
      if (more) entry.more = more;
    }
    files.push(entry);
  }
  files.sort((p, q) => p.path.localeCompare(q.path));
  return { from: a.revision.number, to: b.revision.number, files };
}

/** The most changed files whose text is read to count the words of one revision. */
export const STAT_FILES = 100;

const WORD = /[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*/gu;
const wordsIn = (text: string) => text.match(WORD)?.length ?? 0;

/**
 * Words removed from `a` and added to make `b`, or null where they are too large to compare.
 * The lines the two share at the start and the end are left out first, so that a long text with
 * one change in it is compared by that change and not by its length.
 */
function wordChanges(a: string, b: string): { added: number; removed: number } | null {
  const x = a.split('\n');
  const y = b.split('\n');
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x.at(-1 - e) === y.at(-1 - e)) e++;
  const mid = (l: string[]) => l.slice(s, l.length - e).join('\n');
  const d = diffWords(mid(x), mid(y));
  if (!d) return null;
  const n = (pieces: { changed: boolean; text: string }[]) =>
    pieces.reduce((sum, p) => sum + (p.changed ? wordsIn(p.text) : 0), 0);
  return { removed: n(d.was), added: n(d.now) };
}

/** Count what changed between two lists of files (`before` is empty for the first revision). */
async function statOf(
  store: BlobStore,
  before: RevisionFile[],
  after: RevisionFile[],
): Promise<RevisionStat> {
  const old = new Map(before.map((f) => [f.file_id, f]));
  const now = new Set(after.map((f) => f.file_id));
  const oldAt = new Map(before.filter((f) => !now.has(f.file_id)).map((f) => [f.path, f]));
  // A file deleted and made again at its path is one file, changed (as in `diffRevisions`).
  const pairs: { was: RevisionFile | null; now: RevisionFile | null }[] = [];
  const paired = new Set<string>();
  for (const f of after) {
    const o = old.get(f.file_id);
    if (o) {
      if (o.digest !== f.digest) pairs.push({ was: o, now: f });
      else if (o.path !== f.path) pairs.push({ was: o, now: f });
      continue;
    }
    const swap = oldAt.get(f.path);
    if (swap) {
      paired.add(swap.file_id);
      if (swap.digest !== f.digest) pairs.push({ was: swap, now: f });
    } else pairs.push({ was: null, now: f });
  }
  for (const o of before)
    if (!now.has(o.file_id) && !paired.has(o.file_id)) pairs.push({ was: o, now: null });
  let partial = false;
  let added = 0;
  let removed = 0;
  // Only files whose bytes changed have words to count (a rename alone has none).
  const read = pairs.filter((p) => (p.was?.digest ?? null) !== (p.now?.digest ?? null));
  if (read.length > STAT_FILES) partial = true;
  const text = async (f: RevisionFile | null) => {
    if (!f) return '';
    const size = await store.size(f.digest);
    if (size !== null && size > WHOLE_FILE_BYTES) return undefined;
    const d = decodeFile(await blob(store, f.digest));
    return d.editable ? d.text : null;
  };
  const counted = await mapLimit(read.slice(0, STAT_FILES), READS, async (p) => {
    const [a, b] = [await text(p.was), await text(p.now)];
    // Not text, either side: a changed file and no words. Too large: the same, and said so.
    if (a === null || b === null) return { added: 0, removed: 0, partial: false };
    if (a === undefined || b === undefined) return { added: 0, removed: 0, partial: true };
    if (!p.was) return { added: wordsIn(b), removed: 0, partial: false };
    if (!p.now) return { added: 0, removed: wordsIn(a), partial: false };
    const w = wordChanges(a, b);
    return w ? { ...w, partial: false } : { added: 0, removed: 0, partial: true };
  });
  for (const c of counted) {
    added += c.added;
    removed += c.removed;
    if (c.partial) partial = true;
  }
  return { files: pairs.length, added, removed, ...(partial ? { partial: true as const } : {}) };
}

/**
 * Work out and keep what changed in each of these revisions that has not been counted yet, against
 * the revision before it. A revision never changes, so neither does its count. Nothing is checked
 * of who asks: the caller has.
 */
async function countRevisions(
  pool: pg.Pool,
  store: BlobStore,
  projectId: string,
  revisionIds: string[],
): Promise<void> {
  const { rows } = await pool.query(
    `select r.id, r.number, (select p.id from revisions p
        where p.project_id = r.project_id and p.number < r.number
        order by p.number desc limit 1) as prev
     from revisions r where r.project_id = $1 and r.id = any($2::uuid[]) and r.stat is null`,
    [projectId, revisionIds],
  );
  const filesOf = async (revisionId: string | null): Promise<RevisionFile[]> =>
    revisionId
      ? (
          await pool.query(
            'select file_id, path, digest from revision_files where revision_id = $1',
            [revisionId],
          )
        ).rows
      : [];
  await mapLimit(rows, 4, async (r) => {
    const stat = await statOf(store, await filesOf(r.prev), await filesOf(r.id));
    await pool.query('update revisions set stat = $2 where id = $1 and stat is null', [
      r.id,
      JSON.stringify(stat),
    ]);
  });
}

/**
 * What changed in each of these revisions against the one before it. A revision whose count was
 * not kept (one from before counts were kept, or whose count failed) is counted now and kept, at
 * most `STATS_AT_ONCE` of them per call: the rest answer `null` and are counted by the next call.
 */
export const STATS_AT_ONCE = 20;
export async function revisionStats(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  revisionIds: string[],
): Promise<Map<string, RevisionStat | null>> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const ids = revisionIds.map(id);
  const missing = (
    await pool.query(
      `select id from revisions where project_id = $1 and id = any($2::uuid[]) and stat is null
       order by number desc limit $3`,
      [projectId, ids, STATS_AT_ONCE],
    )
  ).rows.map((r) => r.id);
  if (missing.length) await countRevisions(pool, store, projectId, missing);
  const { rows } = await pool.query(
    'select id, stat from revisions where project_id = $1 and id = any($2::uuid[])',
    [projectId, ids],
  );
  return new Map(rows.map((r) => [r.id, r.stat as RevisionStat | null]));
}

/** Give a file a new path. Its ID, history and open editors stay as they are. */
export async function renameFile(
  db: Db,
  userId: string,
  projectId: string,
  fileId: string,
  path: unknown,
) {
  await authorize(db, userId, id(projectId), 'file.write');
  path = nfc(path);
  const problem = checkPath(path);
  if (problem) throw new AppError('invalid_input', `That name cannot be used: ${problem}.`);
  const tex = texName(path as string);
  if (tex) throw new AppError('invalid_input', tex);
  const taken = await db.query(
    'select 1 from files where project_id = $1 and path = $2 and id <> $3',
    [projectId, path, id(fileId)],
  );
  if (taken.rows[0]) throw new AppError('conflict', 'Another file already has that name.');
  const others = await db.query('select path from files where project_id = $1 and id <> $2', [
    projectId,
    id(fileId),
  ]);
  const clash = pathClash(
    path as string,
    others.rows.map((r) => r.path),
  );
  if (clash) throw new AppError('invalid_input', clashMessage(clash));
  const { rowCount } = await db
    .query('update files set path = $3 where id = $1 and project_id = $2', [
      fileId,
      projectId,
      path,
    ])
    .catch((err) => {
      // The unique index decides, so two people choosing the same name cannot both succeed.
      if (err.code === '23505')
        throw new AppError('conflict', 'Another file already has that name.');
      throw err;
    });
  if (!rowCount) throw new AppError('not_found', 'No such file.');
  await db.query('update projects set manifest_version = manifest_version + 1 where id = $1', [
    projectId,
  ]);
  await filesChanged(db, projectId);
}

/** A root file's path as a shell would take it: "./" in front, and quoted if it needs to be. */
const shellPath = (root: string) =>
  /^[\w./-]+$/.test(root) && !root.startsWith('-') ? root : `'./${root.replaceAll("'", "'\\''")}'`;

const isSpace = (c: string) => /\s/.test(c);

/**
 * The deletes and inserts that turn `have` into `want`, last first, so each position is in terms of
 * `have` and can be applied in the order given. Each changed stretch is replaced on its own, so
 * everything between two changes keeps the identity it has, and with it whatever is anchored there.
 */
export function restoreEdits(
  have: string,
  want: string,
): { at: number; del: number; ins: string }[] {
  const diff = diffLinesFar(have, want);
  if (!diff) {
    // Too many changed lines, or too large to compare: one span, as whole lines.
    let p = 0;
    while (p < have.length && p < want.length && have[p] === want[p]) p++;
    let s = 0;
    while (s < have.length - p && s < want.length - p && have.at(-1 - s) === want.at(-1 - s)) s++;
    while (p > 0 && have[p - 1] !== '\n') p--;
    while (s > 0 && have[have.length - s - 1] !== '\n') s--;
    return [{ at: p, del: have.length - p - s, ins: want.slice(p, want.length - s) }];
  }
  const hl = have.split('\n');
  const wl = want.split('\n');
  // Where each line starts: its length plus one for the newline after it, where there is one.
  // The place after the last line is counted as if it had one too, which clamping undoes.
  const starts = (lines: string[]) => {
    const out = [0];
    for (const l of lines) out.push(out.at(-1)! + l.length + 1);
    return out;
  };
  const hs = starts(hl);
  const edits: { at: number; del: number; ins: string }[] = [];
  let h = 0; // next line of have
  let w = 0; // next line of want
  for (let i = 0; i < diff.length;) {
    if (diff[i].op === ' ') {
      h++;
      w++;
      i++;
      continue;
    }
    let removed = 0;
    let added = 0;
    for (; i < diff.length && diff[i].op !== ' '; i++) {
      if (diff[i].op === '-') removed++;
      else added++;
    }
    const [a, b, c, d] = [h, h + removed, w, w + added];
    h = b;
    w = d;
    if (removed === added) {
      for (let k = 0; k < removed; k++) {
        const [o, n] = [hl[a + k], wl[c + k]];
        if (o === n) continue;
        let cp = 0;
        while (cp < o.length && cp < n.length && o[cp] === n[cp]) cp++;
        let cs = 0;
        while (cs < o.length - cp && cs < n.length - cp && o.at(-1 - cs) === n.at(-1 - cs)) cs++;
        // Never inside a word: the change starts after a space and the kept end starts at one.
        while (cp > 0 && !isSpace(o[cp - 1])) cp--;
        while (cs > 0 && !isSpace(o[o.length - cs])) cs--;
        edits.push({
          at: hs[a + k] + cp,
          del: o.length - cs - cp,
          ins: n.slice(cp, n.length - cs),
        });
      }
      continue;
    }
    const last = b === hl.length; // the hunk runs to the end of the text, which has no newline
    const text = added ? wl.slice(c, d).join('\n') + (d < wl.length ? '\n' : '') : '';
    if (last && a > 0 && (removed === 0 || added === 0)) {
      // The newline before the stretch goes (or comes) with it, as there is none after.
      const at = hs[a] - 1;
      edits.push({
        at,
        del: Math.min(hs[b], have.length + 1) - 1 - at,
        ins: added ? '\n' + text : '',
      });
    } else {
      edits.push({ at: hs[a], del: Math.min(hs[b], have.length) - hs[a], ins: text });
    }
  }
  return edits.reverse();
}

/**
 * Put the paper back to how it was in a revision, as new edits on top of what is there now.
 * Nothing is erased: the restore is itself a new revision, and the ones in between remain. It
 * costs the person the bytes of edits it adds, at least the floor, from their hour's budget.
 */
export async function restoreRevision(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  revisionId: string,
  budget: RewriteOpts = {},
): Promise<{ id: string; number: number }> {
  await authorize(pool, userId, id(projectId), 'revision.write');
  await mayRewrite(pool, userId, budget);
  const { revision, files } = await load(pool, projectId, revisionId);
  const ready = await putEdited(pool, store, projectId);
  // Everything that can be worked out without holding anything is, here: the revision's files are
  // read and the edit that turns each file's text into its text is made. The database and the
  // store may be far away, and typing waits for every round trip made while the files are held.
  const blobs = new Map<string, Uint8Array>();
  const digests = [...new Set(files.map((t) => t.digest))];
  for (let i = 0; i < digests.length; i += 16)
    await Promise.all(
      digests.slice(i, i + 16).map(async (d) => blobs.set(d, await blob(store, d))),
    );
  const prepared = await prepareRestore(pool, projectId, files, blobs);
  // All or nothing, with every file held from here on, so no edit lands between keeping the paper
  // as it stands and replacing it. Typing waits for the moment this takes.
  let appendedTo: string[] = [];
  const made = await transaction(pool, async (db) => {
    const locked = new Map<string, { head_seq: string }>(
      (
        await db.query(
          `select id, head_seq, path, digest, eol, bom from all_files
           where project_id = $1 order by path for update`,
          [projectId],
        )
      ).rows.map((r) => [r.id, r]),
    );
    // What is about to be replaced is kept as a revision first, so a restore erases nothing: not
    // even what someone typed a moment ago.
    await cut(db, store, userId, projectId, { ready });
    // Files deleted since come back as the same files, edit history and all. They wait under a
    // placeholder name until the names they had are free.
    await db.query(
      `update all_files set deleted_at = null, path = id::text || '.renaming'
     where project_id = $1 and deleted_at is not null and id = any($2::uuid[])`,
      [projectId, files.map((t) => t.file_id)],
    );
    const live = (
      await db.query('select id, path, digest, eol, bom from files where project_id = $1', [
        projectId,
      ])
    ).rows;
    // Files added since the revision go.
    for (const extra of live)
      if (!files.some((t) => t.file_id === extra.id)) await removeFile(db, projectId, extra.id);
    // Files whose name must change step aside first, so that two files can swap names.
    const moving = live.filter((f) => files.some((t) => t.file_id === f.id && t.path !== f.path));
    await db.query("update files set path = id::text || '.renaming' where id = any($1::uuid[])", [
      moving.map((f) => f.id),
    ]);
    const appends: { fileId: string; update: Uint8Array }[] = [];
    const restored: { fileId: string; digest: string; size: number }[] = [];
    const renames: { id: string; path: string }[] = [];
    const others: {
      id: string;
      digest: string;
      size: number;
      eol: string | null;
      bom: boolean | null;
      readonly: string | null;
    }[] = [];
    let leftText = false;
    // The bytes of edit this restore adds, for the person's budget.
    let appended = 0;
    for (const target of files) {
      const file = live.find((f) => f.id === target.file_id);
      if (!file) throw new Error(`file ${target.file_id} of revision ${revisionId} is gone`);
      if (file.path !== target.path) renames.push({ id: file.id, path: target.path });
      const bytes = blobs.get(target.digest)!;
      const decoded = file.eol ? decodeFile(bytes) : null;
      if (decoded?.editable) {
        const want = decoded.text;
        const had = prepared.get(file.id);
        // Nobody has typed since it was read: the edit made ahead of time is still the edit.
        if (had && had.seenSeq === String(locked.get(file.id)?.head_seq) && had.eol === file.eol) {
          if (had.update) {
            appends.push({ fileId: file.id, update: had.update });
            appended += had.update.length;
            // The restored file is the revision's bytes, if they are what its row would encode.
            if (
              decoded.meta.eol === file.eol &&
              decoded.meta.bom === !!file.bom &&
              !decoded.meta.mixed
            )
              restored.push({ fileId: file.id, digest: target.digest, size: bytes.length });
          }
          continue;
        }
        appended += await editLocked(db, store, file.id, userId, (text) => {
          for (const e of restoreEdits(text.toString(), want)) {
            if (e.del) text.delete(e.at, e.del);
            if (e.ins) text.insert(e.at, e.ins);
          }
        });
      } else if (file.eol) {
        // Text now, but the revision's bytes are not: the file goes back to being read-only, and
        // its log stays where it is. Connected editors are told below.
        others.push({
          id: file.id,
          digest: target.digest,
          size: bytes.length,
          eol: null,
          bom: null,
          readonly: 'not-utf8',
        });
        leftText = true;
      } else if (file.digest !== target.digest) {
        const meta = fileMeta(target.path, bytes);
        if (!meta.eol) {
          others.push({
            id: file.id,
            digest: target.digest,
            size: bytes.length,
            eol: null,
            bom: null,
            readonly: meta.readonly,
          });
        } else {
          // Read-only now, text in the revision. The row says so first: a log is only edited for
          // a file that is text.
          await db.query(
            `update files set digest = $2, size = $3, eol = $4, bom = $5, readonly_reason = null
             where id = $1`,
            [file.id, target.digest, bytes.length, meta.eol, meta.bom],
          );
          if (Number(locked.get(file.id)?.head_seq) > 0) {
            const read = decodeFile(bytes);
            if (!read.editable)
              throw new Error(`file ${file.id} is text in one place and not in another`);
            const want = read.text;
            appended += await editLocked(db, store, file.id, userId, (text) => {
              for (const e of restoreEdits(text.toString(), want)) {
                if (e.del) text.delete(e.at, e.del);
                if (e.ins) text.insert(e.at, e.ins);
              }
            });
          }
        }
      }
    }
    if (renames.length)
      await db.query(
        `update files f set path = c.path from unnest($1::uuid[], $2::text[]) as c(id, path)
         where f.id = c.id`,
        [renames.map((r) => r.id), renames.map((r) => r.path)],
      );
    const seqs = await appendUpdates(db, projectId, userId, appends);
    appendedTo = [...seqs.keys()];
    // Charged with every edit made: over budget, the transaction ends and none of it is kept.
    await chargeRewrite(db, userId, projectId, appended, budget);
    await notifyEdits(db, seqs);
    if (others.length)
      await db.query(
        `update files f set digest = c.digest, size = c.size, eol = c.eol, bom = c.bom,
           readonly_reason = c.readonly
         from unnest($1::uuid[], $2::text[], $3::int[], $4::text[], $5::bool[], $6::text[])
           as c(id, digest, size, eol, bom, readonly) where f.id = c.id`,
        [
          others.map((o) => o.id),
          others.map((o) => o.digest),
          others.map((o) => o.size),
          others.map((o) => o.eol),
          others.map((o) => o.bom),
          others.map((o) => o.readonly),
        ],
      );
    // Editors of a file that stopped being text are sent away, as for a removed file.
    if (leftText) await db.query("select pg_notify('acl', $1)", [projectId]);
    // What those files now hold is known, so the cut below does not read their logs again.
    for (const r of restored) {
      const seq = seqs.get(r.fileId);
      if (seq !== undefined)
        ready.set(r.fileId, { seq: String(seq), digest: r.digest, size: r.size });
    }
    await db.query(
      `update projects set compiler = $2, manifest_version = manifest_version + 1,
       root_file_id = (select id from files where project_id = $1 and path = $3)
     where id = $1`,
      [projectId, revision.compiler, revision.root],
    );
    const made = await cut(db, store, userId, projectId, {
      kind: 'restore',
      restoredFrom: revisionId,
      ready,
    });
    // Told once the restore commits, after the edits it made: connected editors learn it was one.
    await db.query("select pg_notify('restored', $1)", [`${projectId}:${made.number}`]);
    return made;
  });
  // The files made ahead of time were appended to while held, which did not read their logs (that
  // would add a read to everything typing waits for). Each log is looked at now, once the restore
  // has committed; a file that is not due costs one count. The restore stands whatever this does.
  for (const fileId of appendedTo) await compactIfDue(pool, fileId).catch(() => undefined);
  return made;
}

/**
 * For each file of a revision that is text now and has a log, the edit that would make its text
 * the revision's, and the place in its log that was the text of. An empty edit is `null`. Files
 * with no log yet are left out: the restore makes their first entry itself, holding them.
 */
async function prepareRestore(
  pool: pg.Pool,
  projectId: string,
  targets: RevisionFile[],
  blobs: Map<string, Uint8Array>,
) {
  // Each file's place in its log is read before its log is, as `putEdited` does.
  const { rows } = await pool.query(
    'select id, path, digest, eol, bom, head_seq from files where project_id = $1',
    [projectId],
  );
  const wanted = targets.flatMap((t) => {
    const file = rows.find((f) => f.id === t.file_id);
    const decoded =
      file?.eol && Number(file.head_seq) > 0 ? decodeFile(blobs.get(t.digest)!) : null;
    return file && decoded?.editable ? [{ file, want: decoded.text }] : [];
  });
  const logs = new Map<string, Uint8Array[]>();
  if (wanted.length)
    for (const r of (
      await pool.query(
        'select file_id, update from file_updates where file_id = any($1::uuid[]) order by file_id, seq',
        [wanted.map((w) => w.file.id)],
      )
    ).rows) {
      const log = logs.get(r.file_id) ?? [];
      log.push(new Uint8Array(r.update));
      logs.set(r.file_id, log);
    }
  const out = new Map<string, { update: Uint8Array | null; seenSeq: string; eol: string }>();
  for (const { file, want } of wanted) {
    const log = logs.get(file.id);
    if (!log) continue;
    const doc = new Y.Doc();
    for (const u of log) Y.applyUpdate(doc, u);
    const before = Y.encodeStateVector(doc);
    const text = doc.getText(TEXT);
    for (const e of restoreEdits(text.toString(), want)) {
      if (e.del) text.delete(e.at, e.del);
      if (e.ins) text.insert(e.at, e.ins);
    }
    const update = Y.encodeStateAsUpdate(doc, before);
    // Two zero bytes: nothing was inserted or deleted.
    out.set(file.id, {
      update: update.length <= 2 ? null : update,
      seenSeq: String(file.head_seq),
      eol: file.eol,
    });
  }
  return out;
}

/**
 * The number of the newest restore of the paper a file belongs to, or 0 if it was never restored.
 * A client that reconnects and finds this changed knows the paper was restored while it was away.
 */
export async function lastRestore(db: Db, userId: string, fileId: string): Promise<number> {
  return (await lastRestoreNote(db, userId, fileId))?.number ?? 0;
}

/** What the people who have a paper open are told of a restore of it. */
export type RestoreNote = {
  /** The restore: a revision of its own. */
  id: string;
  number: number;
  /** The revision the paper was put back to, and the name it was given, if any. */
  from: number | null;
  fromName: string | null;
  /** The address of whoever restored it. */
  by: string | null;
  at: string;
  /** The revision made of the paper as it stood at that moment: what the restore replaced. */
  kept: { id: string; number: number } | null;
};

/**
 * Restore number `number` of a paper (the newest, if none is given), for telling its editors.
 * Nothing is checked of who asks: the caller has. `null` if there is no such restore.
 */
export async function restoreNote(
  db: Db,
  projectId: string,
  number?: number,
): Promise<RestoreNote | null> {
  const { rows } = await db.query(
    `select r.id, r.number, f.number as "from", f.name as "fromName", u.email as by,
            r.created_at as at, k.id as "keptId", k.number as "keptNumber"
     from revisions r
     left join revisions f on f.id = r.restored_from
     left join "user" u on u.id = r.created_by
     left join revisions k on k.project_id = r.project_id and k.number = r.number - 1
     where r.project_id = $1 and r.kind = 'restore' and ($2::int is null or r.number = $2)
     order by r.number desc limit 1`,
    [projectId, number ?? null],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    number: r.number,
    from: r.from,
    fromName: r.fromName,
    by: r.by,
    at: new Date(r.at).toISOString(),
    kept: r.keptId ? { id: r.keptId, number: r.keptNumber } : null,
  };
}

/**
 * The restore that took a file out of the paper, for telling whoever had it open. A restore
 * removes the files its revision lacks in the transaction that makes its own revision, so the
 * file's removal and that revision carry the same moment. `null` if the file is in the paper, or
 * was deleted some other way. Nothing is checked of who asks: the caller has.
 */
export async function restoreThatRemoved(
  db: Db,
  projectId: string,
  fileId: string,
): Promise<RestoreNote | null> {
  const { rows } = await db.query(
    `select r.number from all_files f
     join revisions r on r.project_id = f.project_id and r.kind = 'restore'
       and r.created_at = f.deleted_at
     where f.project_id = $1 and f.id = $2`,
    [projectId, id(fileId)],
  );
  return rows[0] ? restoreNote(db, projectId, rows[0].number) : null;
}

/** The newest restore of the paper a file belongs to, for someone who may open that file. */
export async function lastRestoreNote(
  db: Db,
  userId: string,
  fileId: string,
): Promise<RestoreNote | null> {
  const { projectId } = await openFile(db, userId, fileId);
  return restoreNote(db, projectId);
}
