// Asking for builds and reading their results. The worker that does the building lives in
// apps/workers; it takes rows from the builds table.
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { gunzipSync } from 'node:zlib';
import { parseSyncTeX, type SyncTeX, toPdf, toSource } from '@paperweave/latex';

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
  /** True if any file has been edited since this build read it. */
  stale: boolean;
  /** The revision it is of. Null until the worker has taken it. */
  revisionId: string | null;
};

const COLUMNS = `b.id, b.status, b.created_at as "createdAt", b.finished_at as "finishedAt",
  coalesce(b.diagnostics, '[]'::jsonb) as diagnostics, coalesce(b.timed_out, false) as "timedOut",
  b.cached_from is not null as cached, b.pdf_digest is not null as "hasPdf",
  b.revision_id as "revisionId",
  b.revision_id is not null and exists (
    select 1 from files f left join revision_files rf on rf.revision_id = b.revision_id and rf.file_id = f.id
    where f.project_id = b.project_id and (rf.seq is distinct from f.head_seq or rf.path is distinct from f.path)
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

/** The newest build, the newest one that produced a PDF, and how far the paper's edits have got. */
export async function latestBuilds(
  db: Db,
  userId: string,
  projectId: string,
): Promise<{ latest: Build | null; lastGood: Build | null; edits: number }> {
  await authorize(db, userId, id(projectId), 'project.read');
  const latest = await db.query(
    `select ${COLUMNS} from builds b where b.project_id = $1 order by b.created_at desc limit 1`,
    [projectId],
  );
  const good = await db.query(
    `select ${COLUMNS} from builds b where b.project_id = $1 and b.pdf_digest is not null
     order by b.created_at desc limit 1`,
    [projectId],
  );
  // A number that moves whenever any file is edited: lets a client see that typing has paused.
  const edits = await db.query(
    'select coalesce(sum(head_seq), 0)::float as n from files where project_id = $1',
    [projectId],
  );
  return { latest: latest.rows[0] ?? null, lastGood: good.rows[0] ?? null, edits: edits.rows[0].n };
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
  return { sync, files };
}
const nowhere = () => new AppError('not_found', 'The PDF does not say where that is.');

/** Where a line of a file is in a build's PDF: the page, and a place on it in PDF points. */
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
  const { sync, files } = await syncOf(db, store, userId, projectId, buildId);
  const path = files.find((f) => f.file_id === fileId)?.path;
  const place = path === undefined ? null : toPdf(sync, path, line);
  if (!place) throw nowhere();
  return place;
}

/** The file and line that made what is at a point of a page of a build's PDF. */
export async function pdfToSource(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  buildId: string,
  page: number,
  x: number,
  y: number,
) {
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y))
    throw new AppError('invalid_input', 'No such place.');
  const { sync, files } = await syncOf(db, store, userId, projectId, buildId);
  const found = toSource(sync, page, x, y);
  const file = found && files.find((f) => f.path === found.path);
  // A line of a file the build made for itself (the bibliography's .bbl) is nobody's to edit.
  if (!found || !file) throw nowhere();
  return { fileId: file.file_id, path: file.path, line: found.line };
}
