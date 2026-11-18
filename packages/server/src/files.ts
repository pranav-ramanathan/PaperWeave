// Adding and removing a paper's files, and choosing its root.
import { decodeFile } from '@paperweave/latex';
import type pg from 'pg';
import { checkPath, LIMITS } from './archive.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { cutRevision } from './revisions.ts';

/** Extensions that hold text the editors can open. Everything else is kept as bytes. */
export const TEXT_FILE = /\.(tex|ltx|bib|bst|cls|sty|bbx|cbx|def|cfg|clo|csv|tsv|txt|md)$/i;

/** The newline style, byte order mark or read-only reason to record for a file's bytes. */
export function fileMeta(path: string, bytes: Uint8Array) {
  const decoded = TEXT_FILE.test(path) ? decodeFile(bytes) : null;
  if (!decoded) return { eol: null, bom: null, readonly: 'binary' };
  if (!decoded.editable) return { eol: null, bom: null, readonly: decoded.reason };
  return { eol: decoded.meta.eol, bom: decoded.meta.bom, readonly: null };
}

/**
 * Add a file to a paper: an upload, or an empty text file when no bytes are given. The first
 * .tex file of a paper that has no root file becomes its root.
 */
export async function createFile(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  path: unknown,
  bytes: Uint8Array = new Uint8Array(),
): Promise<string> {
  await authorize(db, userId, id(projectId), 'file.write');
  const problem = checkPath(path);
  if (problem) throw new AppError('invalid_input', `That name cannot be used: ${problem}.`);
  if (bytes.length > LIMITS.fileBytes)
    throw new AppError('invalid_input', 'That file is too large.');
  const count = await db.query('select count(*)::int as n from files where project_id = $1', [
    projectId,
  ]);
  if (count.rows[0].n >= LIMITS.files)
    throw new AppError('invalid_input', 'This paper has too many files.');
  const meta = fileMeta(path as string, bytes);
  const digest = await store.put(bytes);
  const made = await db
    .query(
      `insert into files (project_id, path, digest, size, eol, bom, readonly_reason)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [projectId, path, digest, bytes.length, meta.eol, meta.bom, meta.readonly],
    )
    .catch((err) => {
      // The unique index decides, so two people adding the same name cannot both succeed.
      if (err.code === '23505')
        throw new AppError('conflict', 'Another file already has that name.');
      throw err;
    });
  const fileId: string = made.rows[0].id;
  const root = !meta.readonly && /\.(tex|ltx)$/i.test(path as string);
  await db.query(
    `update projects set manifest_version = manifest_version + 1,
       root_file_id = case when $3 then coalesce(root_file_id, $2) else root_file_id end
     where id = $1`,
    [projectId, fileId, root],
  );
  return fileId;
}

/**
 * Remove a file from a paper. The paper is saved as a revision first, so the file can always be
 * brought back by restoring. Anyone who has it open is disconnected from it. Returns the file's
 * name and the number of the revision that still has it.
 */
export async function deleteFile(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId: string,
) {
  await authorize(pool, userId, id(projectId), 'file.write');
  const file = (
    await pool.query(
      `select f.id, f.path, p.root_file_id = f.id as root from files f join projects p on p.id = f.project_id
       where f.id = $1 and f.project_id = $2`,
      [id(fileId), projectId],
    )
  ).rows[0];
  if (!file) throw new AppError('not_found', 'No such file.');
  if (file.root)
    throw new AppError('invalid_input', 'This is the root file. Make another file the root first.');
  const saved = await cutRevision(pool, store, userId, projectId);
  await removeFile(pool, projectId, fileId);
  return { path: file.path as string, revision: saved.number };
}

/** Hide a file from the paper and tell the sync server. No checks: callers do those. */
export async function removeFile(db: Db, projectId: string, fileId: string) {
  await db.query('update files set deleted_at = now() where id = $1 and project_id = $2', [
    fileId,
    projectId,
  ]);
  await db.query('update projects set manifest_version = manifest_version + 1 where id = $1', [
    projectId,
  ]);
  // Open connections to the file are re-checked, find it gone, and are closed.
  await db.query("select pg_notify('acl', $1)", [projectId]);
}

/** Make a .tex file the one the paper is built from. */
export async function setRootFile(db: Db, userId: string, projectId: string, fileId: string) {
  await authorize(db, userId, id(projectId), 'file.write');
  const { rowCount } = await db.query(
    `update projects set root_file_id = $2, manifest_version = manifest_version + 1
     where id = $1 and exists (
       select 1 from files where id = $2 and project_id = $1 and eol is not null and path ~* '\\.(tex|ltx)$'
     )`,
    [projectId, id(fileId)],
  );
  if (!rowCount)
    throw new AppError('invalid_input', 'Only a .tex file of this paper can be the root.');
}
