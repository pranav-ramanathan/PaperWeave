// Asking for builds and reading their results. The worker that does the building lives in
// apps/workers; it takes rows from the builds table.
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { currentBytes } from './sync.ts';
import { carryLine, diffLines } from './textdiff.ts';
import { gunzipSync } from 'node:zlib';
import { decodeFile, parseSyncTeX, type SyncTeX, toPdf, toSource } from '@paperweave/latex';

export const BUILDS_PER_HOUR = 120;

export type Diagnostic = {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
};
export type Build = {
  id: string;
  status: 'queued' | 'succeeded' | 'failed';
  createdAt: string;
  finishedAt: string | null;
  diagnostics: Diagnostic[];
  timedOut: boolean;
  cached: boolean;
  hasPdf: boolean;
  /** True if the paper is no longer what this build read: an edit, a file added, replaced,
   * renamed or deleted, another root. */
  stale: boolean;
  /** The revision it is of. Null until the worker has taken it. */
  revisionId: string | null;
};

const COLUMNS = `b.id, b.status, b.created_at as "createdAt", b.finished_at as "finishedAt",
  coalesce(b.diagnostics, '[]'::jsonb) as diagnostics, coalesce(b.timed_out, false) as "timedOut",
  b.cached_from is not null as cached, b.pdf_digest is not null as "hasPdf",
  b.revision_id as "revisionId",
  b.revision_id is not null and (
    exists (
      select 1 from files f left join revision_files rf on rf.revision_id = b.revision_id and rf.file_id = f.id
      where f.project_id = b.project_id and (
        rf.file_id is null or rf.path is distinct from f.path
        -- A file's log starts at nothing and gets its first entry, the upload itself, the first
        -- time the file is opened. Neither is an edit.
        or greatest(rf.seq, 1) <> greatest(f.head_seq, 1)
        -- A file that is not text has no log: it is replaced whole, as a chart is when drawn again.
        or (f.eol is null and rf.digest <> f.digest)
      )
    )
    -- A file the build read has since been deleted.
    or exists (
      select 1 from revision_files rf where rf.revision_id = b.revision_id
        and not exists (select 1 from files f where f.id = rf.file_id)
    )
    -- The paper is now built from another file, or with another compiler.
    or exists (
      select 1 from revisions r join projects p on p.id = r.project_id
        left join files root on root.id = p.root_file_id
      where r.id = b.revision_id and (r.root is distinct from root.path or r.compiler <> p.compiler)
    )
  ) as stale`;

/**
 * Queue a build of the paper as it will stand when the worker picks it up, or of one given
 * revision. Asking while the same build is already waiting returns that one, so a burst of
 * requests becomes a single build.
 */
export async function requestBuild(
  db: Db,
  userId: string,
  projectId: string,
  opts: { perHour?: number; revisionId?: string } = {},
): Promise<string> {
  const perHour = opts.perHour ?? BUILDS_PER_HOUR;
  await authorize(db, userId, id(projectId), 'build.run');
  // Building a given revision: it must be one of this paper's.
  if (opts.revisionId) {
    const own = await db.query('select 1 from revisions where id = $1 and project_id = $2', [
      id(opts.revisionId),
      projectId,
    ]);
    if (!own.rows[0]) throw new AppError('not_found', 'No such revision.');
  }
  const waiting = await db.query(
    "select id from builds where project_id = $1 and status = 'queued' and revision_id is not distinct from $2",
    [projectId, opts.revisionId ?? null],
  );
  if (waiting.rows[0]) return waiting.rows[0].id;
  const recent = await db.query(
    "select count(*)::int as n from builds where project_id = $1 and created_at > now() - interval '1 hour'",
    [projectId],
  );
  if (recent.rows[0].n >= perHour)
    throw new AppError(
      'conflict',
      `This paper has been built ${perHour} times in the last hour. Try again in a little while.`,
    );
  const made = await db.query(
    `insert into builds (project_id, requested_by, revision_id) values ($1, $2, $3)
     on conflict do nothing returning id`,
    [projectId, userId, opts.revisionId ?? null],
  );
  // Lost a race with another request: theirs is the build.
  const buildId =
    made.rows[0]?.id ??
    (
      await db.query(
        "select id from builds where project_id = $1 and status = 'queued' and revision_id is not distinct from $2",
        [projectId, opts.revisionId ?? null],
      )
    ).rows[0].id;
  await db.query("select pg_notify('builds', '')");
  return buildId;
}

/**
 * The newest build, the newest one that produced a PDF, and a mark that moves whenever the paper
 * changes: by typing, or by a file being added, replaced, renamed or deleted.
 */
export async function latestBuilds(
  db: Db,
  userId: string,
  projectId: string,
): Promise<{ latest: Build | null; lastGood: Build | null; edits: string }> {
  await authorize(db, userId, id(projectId), 'project.read');
  const latest = await db.query(
    `select ${COLUMNS} from builds b where b.project_id = $1 order by b.created_at desc limit 1`,
    [projectId],
  );
  // Usually the newest build has a PDF, and is then the newest with one: not looked up twice.
  // Every open editor asks this every two seconds.
  const newest: Build | null = latest.rows[0] ?? null;
  const good: Build | null = newest?.hasPdf
    ? newest
    : ((
        await db.query(
          `select ${COLUMNS} from builds b where b.project_id = $1 and b.pdf_digest is not null
           order by b.created_at desc limit 1`,
          [projectId],
        )
      ).rows[0] ?? null);
  // Lets a client see that the paper has been still since it last looked.
  const edits = await db.query(
    `select p.manifest_version || '.' || coalesce(sum(f.head_seq), 0) as mark
     from projects p left join files f on f.project_id = p.id where p.id = $1
     group by p.manifest_version`,
    [projectId],
  );
  return {
    latest: newest,
    lastGood: good,
    edits: edits.rows[0].mark,
  };
}

/** One output of a build. The build must belong to a paper the user is on. */
export async function buildOutput(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  buildId: string,
  what: 'pdf' | 'log' | 'synctex',
): Promise<Uint8Array> {
  // `what` names a column, so it must be one of these three and nothing else.
  if (!['pdf', 'log', 'synctex'].includes(what))
    throw new AppError('not_found', 'No such build output.');
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select ${what}_digest as digest from builds where id = $1 and project_id = $2`,
    [id(buildId), projectId],
  );
  const bytes = rows[0]?.digest && (await store.get(rows[0].digest));
  if (!bytes) throw new AppError('not_found', 'No such build output.');
  return bytes;
}

/**
 * The number and page LaTeX gave each label in a build: what `\\ref` prints in that build's PDF.
 * The build must belong to a paper the user is on.
 */
export async function buildLabels(
  db: Db,
  userId: string,
  projectId: string,
  buildId: string,
): Promise<Record<string, { number: string; page: string }>> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query('select labels from builds where id = $1 and project_id = $2', [
    id(buildId),
    projectId,
  ]);
  if (!rows[0]) throw new AppError('not_found', 'No such build.');
  return rows[0].labels ?? {};
}

/**
 * How the build queue is doing, across all papers: for the people who run the service, not for
 * the people who use it. Counts and ages only.
 */
export async function buildHealth(db: Db) {
  const { rows } = await db.query(
    `select
       count(*) filter (where status = 'queued')::int as queued,
       coalesce(extract(epoch from now() - min(created_at) filter (where status = 'queued')), 0)::float
         as "oldestQueuedSeconds",
       count(*) filter (where status = 'succeeded' and finished_at > now() - interval '1 hour')::int
         as succeeded,
       count(*) filter (where status = 'failed' and finished_at > now() - interval '1 hour')::int
         as failed,
       count(*) filter (where timed_out and finished_at > now() - interval '1 hour')::int
         as "timedOut"
     from builds`,
  );
  return rows[0] as {
    queued: number;
    oldestQueuedSeconds: number;
    succeeded: number;
    failed: number;
    timedOut: number;
  };
}

/** Read SyncTeX files, kept for the next few questions about the same build. */
const read = new Map<string, SyncTeX>();
async function syncOf(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  buildId: string,
) {
  await authorize(db, userId, id(projectId), 'project.read');
  const build = (
    await db.query(
      'select synctex_digest, revision_id from builds where id = $1 and project_id = $2',
      [id(buildId), projectId],
    )
  ).rows[0];
  const digest: string | undefined = build?.synctex_digest;
  if (!digest) throw new AppError('not_found', 'That build has nothing to go by.');
  let sync = read.get(digest);
  if (!sync) {
    const bytes = await store.get(digest);
    if (!bytes) throw new AppError('not_found', 'That build has nothing to go by.');
    sync = parseSyncTeX(gunzipSync(bytes).toString('latin1'));
    // shortcut: a handful of builds kept per process, the oldest dropped; share them between
    // processes if reading them ever shows up in timings.
    if (read.size >= 8) read.delete(read.keys().next().value!);
    read.set(digest, sync);
  }
  // The files as they were named in the revision that was built.
  const files: { file_id: string; path: string }[] = (
    await db.query('select file_id, path from revision_files where revision_id = $1', [
      build.revision_id,
    ])
  ).rows;
  return { sync, files, revisionId: (build.revision_id as string | null) ?? null };
}
const nowhere = () => new AppError('not_found', 'The PDF does not say where that is.');

type LineMap = {
  /** A line of the file as it was in the built revision, as it is now. */
  toNow: (line: number) => { line: number; moved: boolean };
  /** A line of the file as it is now, as it was in the built revision. */
  toBuilt: (line: number) => { line: number; moved: boolean };
};

/**
 * How the lines of a file, as they were in a revision, are numbered in the file now, and back.
 * `'gone'` if the file is no longer in the paper. A line that was removed (or added since) maps to
 * the nearest line that is in both, and says it `moved`.
 */
export async function lineMap(
  db: Db,
  store: BlobStore,
  projectId: string,
  revisionId: string | null,
  fileId: string,
): Promise<LineMap | 'gone'> {
  const now = (
    await db.query(
      'select id, digest, eol, bom, head_seq from files where id = $1 and project_id = $2',
      [fileId, projectId],
    )
  ).rows[0];
  if (!now) return 'gone';
  const same: LineMap = {
    toNow: (line) => ({ line, moved: false }),
    toBuilt: (line) => ({ line, moved: false }),
  };
  const kept = (moved: boolean): LineMap => ({
    toNow: (line) => ({ line, moved }),
    toBuilt: (line) => ({ line, moved }),
  });
  const built = revisionId
    ? (
        await db.query(
          'select digest from revision_files where revision_id = $1 and file_id = $2',
          [revisionId, fileId],
        )
      ).rows[0]
    : undefined;
  // Not in the built revision: nothing to carry a line from.
  if (!built) return kept(true);
  const [a, b] = await Promise.all([
    store.get(built.digest).then((bytes) => bytes && decodeFile(bytes)),
    currentBytes(db, store, now).then(decodeFile),
  ]);
  if (!a || !a.editable || !b.editable) return kept(true);
  if (a.text === b.text) return same;
  const diff = diffLines(a.text, b.text);
  return {
    toNow: (line) => carryLine(diff, line, 'toNow'),
    toBuilt: (line) => carryLine(diff, line, 'toBuilt'),
  };
}

/**
 * Where a line of a file, as it is now, is in a build's PDF: the page, and a place on it in PDF
 * points. `moved` is true if the PDF is of text that had no such line, so the place is the nearest.
 */
export async function sourceToPdf(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  buildId: string,
  fileId: string,
  line: number,
) {
  if (!Number.isInteger(line) || line < 1) throw new AppError('invalid_input', 'No such line.');
  const { sync, files, revisionId } = await syncOf(db, store, userId, projectId, buildId);
  // The file as the build had it: its path then, and its lines.
  const path = files.find((f) => f.file_id === fileId)?.path;
  if (path === undefined) throw nowhere();
  const map = await lineMap(db, store, projectId, revisionId, fileId);
  if (map === 'gone') throw nowhere();
  const built = map.toBuilt(line);
  const place = toPdf(sync, path, built.line);
  if (!place) throw nowhere();
  return { ...place, moved: built.moved };
}

/**
 * The file and line that made what is at a point of a page of a build's PDF, as the file and its
 * line stand now. `moved` is true if the line is the nearest to one that has been edited away.
 */
export async function pdfToSource(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  buildId: string,
  page: number,
  x: number,
  y: number,
  nearest = false,
) {
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y))
    throw new AppError('invalid_input', 'No such place.');
  const { sync, files, revisionId } = await syncOf(db, store, userId, projectId, buildId);
  const found = toSource(sync, page, x, y, nearest);
  const file = found && files.find((f) => f.path === found.path);
  // A line of a file the build made for itself (the bibliography's .bbl) is nobody's to edit.
  if (!found || !file) throw nowhere();
  const gone = () =>
    new AppError(
      'not_found',
      'That part of the PDF came from a file that is no longer in the paper.',
    );
  // Its path now: it may have been renamed since, or deleted.
  const path: string | undefined = (
    await db.query('select path from files where id = $1 and project_id = $2', [
      file.file_id,
      projectId,
    ])
  ).rows[0]?.path;
  if (path === undefined) throw gone();
  const map = await lineMap(db, store, projectId, revisionId, file.file_id);
  if (map === 'gone') throw gone();
  const now = map.toNow(found.line);
  return { fileId: file.file_id, path, line: now.line, moved: now.moved };
}
