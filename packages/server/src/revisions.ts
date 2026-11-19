// Revisions: the paper frozen at a moment. Cutting, naming, comparing, restoring and exporting.
import { createHash } from 'node:crypto';
import { decodeFile } from '@paperweave/latex';
import type pg from 'pg';
import { checkPath, type Entry, writeZip } from './archive.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { removeFile } from './files.ts';
import { recordDownload } from './metrics.ts';
import { id } from './projects.ts';
import { currentBytes, editLocked, openFile } from './sync.ts';
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
  opts: { name?: string; kind?: Revision['kind']; restoredFrom?: string } = {},
): Promise<{ id: string; number: number }> {
  const ready = await putEdited(pool, store, projectId);
  return transaction(pool, (db) => cut(db, store, userId, projectId, { ...opts, ready }));
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
  const ready: Ready = new Map();
  for (const f of rows) {
    const bytes = await currentBytes(pool, store, f);
    ready.set(f.id, {
      seq: String(f.head_seq),
      digest: await store.put(bytes),
      size: bytes.length,
    });
  }
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
  await authorize(db, userId, id(projectId), 'project.export');
  const { revision, files } = await load(db, projectId, revisionId);
  // Data goes into a download only if its author has said so. A CSV file nobody has described
  // as data is a file like any other.
  const held = new Set(
    (
      await db.query('select file_id from datasets where project_id = $1 and not exported', [
        projectId,
      ])
    ).rows.map((r) => r.file_id),
  );
  const shared = files.filter((f) => !held.has(f.file_id));
  const entries: Entry[] = [];
  for (const f of shared) entries.push({ path: f.path, bytes: await blob(store, f.digest) });
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
        return from ? [[f.path, from.record]] : [];
      }),
    );
    const epoch = Math.floor(new Date(revision.created_at).getTime() / 1000);
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
        command: `SOURCE_DATE_EPOCH=${epoch} latexmk -norc ${engine} -no-shell-escape -interaction=nonstopmode ${revision.root}`,
        files: Object.fromEntries(shared.map((f) => [f.path, `sha256:${f.digest}`])),
        charts,
      },
      null,
      2,
    );
    entries.push({ path: 'paperweave-toolchain.json', bytes: Buffer.from(text + '\n') });
  }
  await recordDownload(db, projectId, 'zip');
  return {
    zip: await writeZip([...entries, ...extra]),
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
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select b.pdf_digest from builds b where b.revision_id = $1 and b.project_id = $2
       and b.pdf_digest is not null order by b.created_at desc limit 1`,
    [id(revisionId), projectId],
  );
  if (!rows[0]) throw new AppError('not_found', 'This revision has not been built.');
  await recordDownload(db, projectId, 'pdf');
  return blob(store, rows[0].pdf_digest);
}

export type FileDiff = {
  path: string;
  /** The earlier path, if the file was renamed. */
  was?: string;
  status: 'added' | 'removed' | 'changed' | 'renamed';
  /** Line by line, for text that changed. Null for other files and for files too large. */
  lines: DiffLine[] | null;
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
  const text = async (digest: string) => {
    const d = decodeFile(await blob(store, digest));
    return d.editable ? d.text : null;
  };
  const files: FileDiff[] = [];
  for (const f of b.files) {
    const old = a.files.find((o) => o.file_id === f.file_id);
    if (!old) files.push({ path: f.path, status: 'added', lines: null });
    else if (old.digest !== f.digest) {
      const [x, y] = [await text(old.digest), await text(f.digest)];
      const was = old.path !== f.path ? old.path : undefined;
      files.push({
        path: f.path,
        was,
        status: 'changed',
        lines: x != null && y != null ? diffLines(x, y) : null,
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
  const { rowCount } = await db.query(
    'update files set path = $3 where id = $1 and project_id = $2',
    [fileId, projectId, path],
  );
  if (!rowCount) throw new AppError('not_found', 'No such file.');
  await db.query('update projects set manifest_version = manifest_version + 1 where id = $1', [
    projectId,
  ]);
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
  // All or nothing, with every file held from here on, so no edit lands between keeping the paper
  // as it stands and replacing it. Typing waits for the moment this takes.
  return transaction(pool, async (db) => {
    await db.query('select 1 from all_files where project_id = $1 order by path for update', [
      projectId,
    ]);
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
      await db.query('select id, path, digest, eol from files where project_id = $1', [projectId])
    ).rows;
    // Files added since the revision go.
    for (const extra of live)
      if (!files.some((t) => t.file_id === extra.id)) await removeFile(db, projectId, extra.id);
    // Files whose name must change step aside first, so that two files can swap names.
    const moving = live.filter((f) => files.some((t) => t.file_id === f.id && t.path !== f.path));
    await db.query("update files set path = id::text || '.renaming' where id = any($1::uuid[])", [
      moving.map((f) => f.id),
    ]);
    for (const target of files) {
      const file = live.find((f) => f.id === target.file_id);
      if (!file) throw new Error(`file ${target.file_id} of revision ${revisionId} is gone`);
      if (file.path !== target.path)
        await db.query('update files set path = $2 where id = $1', [file.id, target.path]);
      const bytes = await blob(store, target.digest);
      const decoded = file.eol ? decodeFile(bytes) : null;
      if (decoded?.editable) {
        const want = decoded.text;
        await editLocked(db, store, file.id, userId, (text) => {
          const have = text.toString();
          // Replace only the part that differs, so people editing elsewhere are not disturbed.
          let p = 0;
          while (p < have.length && p < want.length && have[p] === want[p]) p++;
          let s = 0;
          while (s < have.length - p && s < want.length - p && have.at(-1 - s) === want.at(-1 - s))
            s++;
          // Whole lines only. An edit made offline before the restore is merged in at an edge of
          // the replaced part; this way it lands between two lines, never inside one.
          while (p > 0 && have[p - 1] !== '\n') p--;
          while (s > 0 && have[have.length - s - 1] !== '\n') s--;
          text.delete(p, have.length - p - s);
          text.insert(p, want.slice(p, want.length - s));
        });
      } else if (file.digest !== target.digest)
        await db.query('update files set digest = $2, size = $3 where id = $1', [
          file.id,
          target.digest,
          bytes.length,
        ]);
    }
    await db.query(
      `update projects set compiler = $2, manifest_version = manifest_version + 1,
       root_file_id = (select id from files where project_id = $1 and path = $3)
     where id = $1`,
      [projectId, revision.compiler, revision.root],
    );
    return cut(db, store, userId, projectId, { kind: 'restore', restoredFrom: revisionId });
  });
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
