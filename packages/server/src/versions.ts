// Versions of a paper: named lines of work on one paper. A version is a paper of its own, linked
// to the paper it was started from ("main") and begun at one of main's revisions, so that sync,
// builds, comments, proposals and exports treat it as a paper. Only this file and the member
// functions of projects.ts know otherwise. Behind the `VERSIONS` setting (docs/settings.md).
//
// Who may do what is asked of `authorize` with the actions that exist: seeing a version is
// `project.read`, starting and renaming one is `revision.write` (as saving a revision is), and
// deleting one is `project.settings` (as deleting a paper is). A version has the same people and
// roles as its paper, copied when it is started and kept so by the member functions.
import type pg from 'pg';
import { LIMITS } from './archive.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { transaction } from './db.ts';
import { AppError } from './errors.ts';
import { fileMeta } from './files.ts';
import { id, mayStartPapers } from './projects.ts';
import { blob, cut, load } from './revisions.ts';
import type { Db } from './db.ts';

/** How many versions one paper may have. Deleted ones are gone, so they are not counted. */
export const MAX_VERSIONS = 10;

/**
 * Whether versions are turned on: `VERSIONS` is `1` (on) or `0` or unset (off). Anything else is
 * a mistake in the deployment and stops the one that asks, rather than being read as one or the
 * other.
 */
export function versionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.VERSIONS?.trim();
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error(`VERSIONS must be 1 or 0, not "${value}"`);
}

/** A version's name: one line of 1 to 60 characters, and not "main", which is the paper's own. */
export function versionName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60)
    throw new AppError('invalid_input', 'A version needs a name of at most 60 characters.');
  if (/\p{Cc}|\p{Zl}|\p{Zp}/u.test(name))
    throw new AppError(
      'invalid_input',
      "A version's name must be on one line, without line breaks or other control characters.",
    );
  const named = name.trim();
  if (named.toLowerCase() === 'main')
    throw new AppError('invalid_input', '"main" is the name of the paper itself. Choose another.');
  return named;
}

const taken = (err: unknown) => (err as { code?: string }).code === '23505';
const nameTaken = () =>
  new AppError('conflict', 'This paper already has a version of that name. Choose another.');

export type Version = {
  id: string;
  /** The paper this is a version of. */
  paper: string;
  name: string;
  createdAt: string;
  /** The address of whoever started it. */
  createdBy: string | null;
  /** The revision of the paper it began at. */
  base: { id: string; number: number } | null;
};

/**
 * Start a version of a paper at one of its revisions: a new paper with the revision's files (each
 * with an id of its own, and the origin of the file it was copied from), root and compiler; the
 * paper's people, language, words and data descriptions (held data stays held), and its charts;
 * and revision 1 cut at once. No bytes are copied, the store being addressed by content, and
 * no edit logs: a file's first entry is made from its bytes when it is first opened. Comments and
 * proposed changes stay with the paper. All or nothing.
 */
export async function startVersion(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  revisionId: string,
  name: unknown,
  opts: {
    env?: Record<string, string | undefined>;
    perHour?: number;
    max?: number;
  } = {},
): Promise<{ id: string; name: string; revision: number }> {
  // Off, there is nothing to start: the same answer as for a page that does not exist.
  if (!versionsEnabled(opts.env)) throw new AppError('not_found', 'Versions are not turned on.');
  await authorize(pool, userId, id(projectId), 'revision.write');
  const named = versionName(name);
  await mayStartPapers(pool, userId, 1, opts.perHour ?? LIMITS.papersPerHour);

  // Everything that needs the store is done before the transaction, which is not kept waiting.
  const { revision, files } = await load(pool, projectId, revisionId);
  const rows = (
    await pool.query(
      `select id, origin_id, digest, size, eol, bom, readonly_reason from all_files
       where project_id = $1 and id = any($2::uuid[])`,
      [projectId, files.map((f) => f.file_id)],
    )
  ).rows as {
    id: string;
    origin_id: string | null;
    digest: string;
    size: number;
    eol: 'lf' | 'crlf' | null;
    bom: boolean | null;
    readonly_reason: string | null;
  }[];
  const made = new Map(rows.map((r) => [r.id, r]));
  const copies: {
    old: string;
    path: string;
    digest: string;
    size: number;
    eol: string | null;
    bom: boolean | null;
    readonly: string | null;
    origin: string;
  }[] = [];
  for (const f of files) {
    const row = made.get(f.file_id);
    // The row of the file says what its bytes are, if they are still what the revision holds;
    // otherwise (text edited since) the bytes are looked at.
    const known = row && row.digest === f.digest ? row : null;
    const bytes = known ? null : await blob(store, f.digest);
    const meta = known
      ? { eol: known.eol, bom: known.bom, readonly: known.readonly_reason }
      : fileMeta(f.path, bytes!);
    copies.push({
      old: f.file_id,
      path: f.path,
      digest: f.digest,
      size: known ? known.size : bytes!.length,
      ...meta,
      origin: row?.origin_id ?? f.file_id,
    });
  }

  try {
    return await transaction(pool, async (db) => {
      // Held, so that two versions started at once cannot both be the tenth.
      const paper = (
        await db.query(
          `select name, parent_id, language, glossary, grammar_off, model_processing
           from projects where id = $1 for update`,
          [projectId],
        )
      ).rows[0];
      if (!paper) throw new AppError('not_found', 'No such project.');
      if (paper.parent_id)
        throw new AppError(
          'invalid_input',
          'A version cannot have versions of its own. Start it from the paper.',
        );
      const have = (
        await db.query('select count(*)::int as n from projects where parent_id = $1', [projectId])
      ).rows[0].n;
      const max = opts.max ?? MAX_VERSIONS;
      if (have >= max)
        throw new AppError(
          'conflict',
          `A paper can have ${max} versions, and this one has ${have}. Delete one to start another.`,
        );
      const version = (
        await db.query(
          `insert into projects (name, parent_id, version_name, base_revision_id, compiler,
             language, glossary, grammar_off, model_processing)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            paper.name,
            projectId,
            named,
            revisionId,
            revision.compiler,
            paper.language,
            JSON.stringify(paper.glossary),
            JSON.stringify(paper.grammar_off),
            paper.model_processing,
          ],
        )
      ).rows[0].id as string;
      // The same people in the same roles, the owner too.
      await db.query(
        `insert into project_members (project_id, user_id, role)
         select $1::uuid, user_id, role from project_members where project_id = $2`,
        [version, projectId],
      );
      const inserted = (
        await db.query(
          `insert into files (project_id, path, digest, size, eol, bom, readonly_reason, origin_id)
           select $1::uuid, c.* from unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::bool[],
             $7::text[], $8::uuid[]) as c(path, digest, size, eol, bom, readonly, origin)
           returning id, path`,
          [
            version,
            copies.map((c) => c.path),
            copies.map((c) => c.digest),
            copies.map((c) => c.size),
            copies.map((c) => c.eol),
            copies.map((c) => c.bom),
            copies.map((c) => c.readonly),
            copies.map((c) => c.origin),
          ],
        )
      ).rows as { id: string; path: string }[];
      const fresh = new Map(inserted.map((r) => [r.path, r.id]));
      const was = copies.map((c) => c.old);
      const now = copies.map((c) => fresh.get(c.path)!);
      await db.query('update projects set root_file_id = $2 where id = $1', [
        version,
        revision.root ? (fresh.get(revision.root) ?? null) : null,
      ]);
      // What was said of the data files, with "kept back" as it was said: a file whose author
      // has not allowed it into downloads is not allowed through a version either.
      await db.query(
        `insert into datasets (file_id, project_id, columns, missing, attribution, exported,
           approved_digest, approved_by, approved_at)
         select m.new, $1::uuid, d.columns, d.missing, d.attribution, d.exported, d.approved_digest,
           d.approved_by, d.approved_at
         from datasets d join unnest($2::uuid[], $3::uuid[]) as m(old, new) on d.file_id = m.old`,
        [version, was, now],
      );
      await db.query(
        `insert into charts (project_id, name, dataset_file_id, spec, status, problem, drawn_digest,
           left_out, created_by, created_at, drawn_at, caption, alt)
         select $1::uuid, c.name, m.new, c.spec, c.status, c.problem, c.drawn_digest, c.left_out,
           c.created_by, c.created_at, c.drawn_at, c.caption, c.alt
         from charts c join unnest($2::uuid[], $3::uuid[]) as m(old, new)
           on c.dataset_file_id = m.old
         where c.project_id = $4`,
        [version, was, now, projectId],
      );
      const first = await cut(db, store, userId, version);
      return { id: version, name: named, revision: first.number };
    });
  } catch (err) {
    if (taken(err)) throw nameTaken();
    throw err;
  }
}

/**
 * The versions of a paper, oldest first, for anyone who may see the paper. Asked of a version,
 * it answers for its paper, so that every page can ask with the id it has.
 */
export async function listVersions(db: Db, userId: string, projectId: string): Promise<Version[]> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select v.id, v.parent_id as paper, v.version_name as name, v.created_at as "createdAt",
            u.email as "createdBy", r.id as "baseId", r.number as "baseNumber"
     from projects me join projects v on v.parent_id = coalesce(me.parent_id, me.id)
     left join revisions r on r.id = v.base_revision_id
     left join "user" u on u.id = (
       select r1.created_by from revisions r1 where r1.project_id = v.id and r1.number = 1)
     where me.id = $1 order by v.created_at, v.id`,
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    paper: r.paper,
    name: r.name,
    createdAt: new Date(r.createdAt).toISOString(),
    createdBy: r.createdBy,
    base: r.baseId ? { id: r.baseId, number: r.baseNumber } : null,
  }));
}

/** Give a version another name. Owner and editors, as starting one. */
export async function renameVersion(
  db: Db,
  userId: string,
  versionId: string,
  name: unknown,
): Promise<{ name: string }> {
  await authorize(db, userId, id(versionId), 'revision.write');
  const named = versionName(name);
  const { rowCount } = await db
    .query('update projects set version_name = $2 where id = $1 and parent_id is not null', [
      versionId,
      named,
    ])
    .catch((err) => {
      throw taken(err) ? nameTaken() : err;
    });
  if (!rowCount) throw new AppError('invalid_input', 'That is a paper, not a version.');
  return { name: named };
}

/** How long deleting a version waits for something that holds one of its rows (a running build). */
const DELETE_WAITS_MS = 3000;

/**
 * Delete a version, for everyone on it and for good: its files, revisions, builds, comments and
 * proposed changes. The owner's alone, and the version's exact name is given, asked again by the
 * deleting statement itself. The paper and its other versions are not touched. Open editors of
 * the version are closed at once. Bytes in the store stay (see `deleteProject`).
 */
export async function deleteVersion(
  pool: pg.Pool,
  userId: string,
  versionId: string,
  typedName: string,
  waitsMs = DELETE_WAITS_MS,
): Promise<{ name: string }> {
  await authorize(pool, userId, id(versionId), 'project.settings');
  try {
    return await transaction(pool, async (db) => {
      await db.query(`set local lock_timeout = ${Math.floor(waitsMs)}`);
      const { rows } = await db.query(
        `delete from projects p using project_members m
         where p.id = $1 and p.parent_id is not null and m.project_id = p.id
           and m.user_id = $2 and m.role = 'owner' and p.version_name = $3
         returning p.version_name`,
        [versionId, userId, typedName],
      );
      if (!rows[0]) {
        const there = (await db.query('select parent_id from projects where id = $1', [versionId]))
          .rows[0];
        if (!there) throw new AppError('not_found', 'No such project.');
        if (!there.parent_id)
          throw new AppError(
            'invalid_input',
            'That is a paper, not a version. Nothing was deleted.',
          );
        throw new AppError(
          'invalid_input',
          'The name typed is not the name of this version. Nothing was deleted.',
        );
      }
      await db.query("select pg_notify('acl', $1)", [versionId]);
      return { name: rows[0].version_name as string };
    });
  } catch (err) {
    if (['55P03', '40P01'].includes((err as { code?: string }).code ?? ''))
      throw new AppError(
        'conflict',
        'This version is being built or changed at this moment. Nothing was deleted. Try again in a minute.',
      );
    throw err;
  }
}
