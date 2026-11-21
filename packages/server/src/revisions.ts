// Revisions: the paper frozen at a moment. Cutting, naming, comparing, restoring and exporting.
import { createHash } from 'node:crypto';
import { LATEXMK_RULES, decodeFile } from '@paperweave/latex';
import type pg from 'pg';
import { checkPath, type Entry, writeZip, zipStream } from './archive.ts';
import { mapLimit, READS, readAhead } from './batch.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { removeFile } from './files.ts';
import { recordDownload } from './metrics.ts';
import { id } from './projects.ts';
import * as Y from 'yjs';
import {
  appendUpdates,
  bytesOfLog,
  currentBytes,
  editLocked,
  notifyEdits,
  openFile,
  readLogs,
  TEXT,
} from './sync.ts';
import { type DiffLine, diffLines } from './textdiff.ts';

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
};
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
  return transaction(pool, async (db) => {
    const made = await cut(db, store, userId, projectId, { ...rest, ready });
    await within?.(db);
    return made;
  });
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
  if (typeof name !== 'string' || !name.trim() || name.length > 200)
    throw new AppError('invalid_input', 'A revision needs a name of at most 200 characters.');
  return cutRevision(pool, store, userId, projectId, { name: name.trim(), kind: 'named' });
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
            exists (select 1 from builds b where b.revision_id = r.id and b.pdf_digest is not null) as "hasPdf"
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

/** The files whose authors keep them out of downloads: data not marked to be included. */
async function heldFileIds(db: Db, projectId: string): Promise<Set<string>> {
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
): Promise<{ zip: Uint8Array; paper: string; number: number }> {
  const { shared, rest, paper, number } = await revisionEntries(
    db,
    userId,
    projectId,
    revisionId,
    manifest,
    extra,
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
): Promise<{ zip: ReadableStream<Uint8Array>; paper: string; number: number }> {
  const { shared, rest, paper, number } = await revisionEntries(
    db,
    userId,
    projectId,
    revisionId,
    manifest,
    extra,
  );
  // Each file is added as its blob arrives, in the order of the files, with sixteen being read
  // ahead of the one being added.
  async function* entries(): AsyncGenerator<Entry> {
    yield* readAhead(shared, READS, async (f) => ({
      path: f.path,
      bytes: await blob(store, f.digest),
    }));
    yield* rest;
  }
  return { zip: zipStream(entries()), paper, number };
}

/** What goes into a revision's archive: the files, whose bytes are still to be read, and the rest. */
async function revisionEntries(
  db: Db,
  userId: string,
  projectId: string,
  revisionId: string,
  manifest = false,
  /** More to put in the archive beside the paper's files. */
  extra: Entry[] = [],
): Promise<{ shared: RevisionFile[]; rest: Entry[]; paper: string; number: number }> {
  await authorize(db, userId, id(projectId), 'project.export');
  const { revision, files } = await load(db, projectId, revisionId);
  // Data goes into a download only if its author has said so. A CSV file nobody has described
  // as data is a file like any other. The hold is by file, whichever revision is downloaded.
  const held = await heldFileIds(db, projectId);
  const shared = files.filter((f) => !held.has(f.file_id));
  const kept = files.filter((f) => held.has(f.file_id));
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
        command: `SOURCE_DATE_EPOCH=${epoch} latexmk -norc -cd ${engine} -no-shell-escape -bibtex-cond -interaction=nonstopmode -e '${LATEXMK_RULES}' ${shellPath(revision.root)}`,
        files: Object.fromEntries(shared.map((f) => [f.path, `sha256:${f.digest}`])),
        charts,
        // Data files left out of this archive on purpose: their authors keep them back.
        held: kept.map((f) => f.path),
      },
      null,
      2,
    );
    rest.push({ path: 'paperweave-toolchain.json', bytes: Buffer.from(text + '\n') });
  }
  await recordDownload(db, projectId, 'zip');
  return {
    shared,
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
  /** Line by line, for text that changed. Null for other files and for text too large to compare. */
  lines: DiffLine[] | null;
  /** The file is text on both sides, but too much of it changed to compare line by line here. */
  tooLarge?: true;
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
  // Both sides of every file that changed are read first, sixteen at a time.
  const wanted = new Set<string>();
  for (const f of b.files) {
    const old = a.files.find((o) => o.file_id === f.file_id);
    if (old && old.digest !== f.digest) wanted.add(old.digest).add(f.digest);
  }
  const read = new Map<string, string | null>();
  await mapLimit([...wanted], READS, async (digest) => {
    const d = decodeFile(await blob(store, digest));
    read.set(digest, d.editable ? d.text : null);
  });
  const text = (digest: string) => read.get(digest) ?? null;
  const files: FileDiff[] = [];
  for (const f of b.files) {
    const old = a.files.find((o) => o.file_id === f.file_id);
    if (!old) files.push({ path: f.path, status: 'added', lines: null });
    else if (old.digest !== f.digest) {
      const [x, y] = [text(old.digest), text(f.digest)];
      const was = old.path !== f.path ? old.path : undefined;
      const lines = x != null && y != null ? diffLines(x, y) : null;
      files.push({
        path: f.path,
        was,
        status: 'changed',
        lines,
        ...(x != null && y != null && !lines ? { tooLarge: true as const } : {}),
      });
    } else if (old.path !== f.path)
      files.push({ path: f.path, was: old.path, status: 'renamed', lines: null });
  }
  for (const o of a.files)
    if (!b.files.some((f) => f.file_id === o.file_id))
      files.push({ path: o.path, status: 'removed', lines: null });
  files.sort((p, q) => p.path.localeCompare(q.path));
  return { from: a.revision.number, to: b.revision.number, files };
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
  const problem = checkPath(path);
  if (problem) throw new AppError('invalid_input', `That name cannot be used: ${problem}.`);
  const taken = await db.query(
    'select 1 from files where project_id = $1 and path = $2 and id <> $3',
    [projectId, path, id(fileId)],
  );
  if (taken.rows[0]) throw new AppError('conflict', 'Another file already has that name.');
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
  const diff = diffLines(have, want);
  if (!diff) {
    // Too large to compare line by line: one span, as whole lines.
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
 * Nothing is erased: the restore is itself a new revision, and the ones in between remain.
 */
export async function restoreRevision(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  revisionId: string,
): Promise<{ id: string; number: number }> {
  await authorize(pool, userId, id(projectId), 'revision.write');
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
  return transaction(pool, async (db) => {
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
    const others: { id: string; digest: string; size: number }[] = [];
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
            // The restored file is the revision's bytes, if they are what its row would encode.
            if (decoded.meta.eol === file.eol && decoded.meta.bom === !!file.bom)
              restored.push({ fileId: file.id, digest: target.digest, size: bytes.length });
          }
          continue;
        }
        await editLocked(db, store, file.id, userId, (text) => {
          for (const e of restoreEdits(text.toString(), want)) {
            if (e.del) text.delete(e.at, e.del);
            if (e.ins) text.insert(e.at, e.ins);
          }
        });
      } else if (file.digest !== target.digest)
        others.push({ id: file.id, digest: target.digest, size: bytes.length });
    }
    if (renames.length)
      await db.query(
        `update files f set path = c.path from unnest($1::uuid[], $2::text[]) as c(id, path)
         where f.id = c.id`,
        [renames.map((r) => r.id), renames.map((r) => r.path)],
      );
    const seqs = await appendUpdates(db, projectId, userId, appends);
    await notifyEdits(db, seqs);
    if (others.length)
      await db.query(
        `update files f set digest = c.digest, size = c.size
         from unnest($1::uuid[], $2::text[], $3::int[]) as c(id, digest, size) where f.id = c.id`,
        [others.map((o) => o.id), others.map((o) => o.digest), others.map((o) => o.size)],
      );
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
    return cut(db, store, userId, projectId, {
      kind: 'restore',
      restoredFrom: revisionId,
      ready,
    });
  });
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
  const { projectId } = await openFile(db, userId, fileId);
  const { rows } = await db.query(
    "select coalesce(max(number), 0)::int as n from revisions where project_id = $1 and kind = 'restore'",
    [projectId],
  );
  return rows[0].n;
}
