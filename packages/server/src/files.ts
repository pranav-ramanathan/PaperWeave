// Adding and removing a paper's files, and choosing its root.
import { decodeFile, includes, resolveInclude, rootDir } from '@paperweave/latex';
import type pg from 'pg';
import { checkPath, LIMITS } from './archive.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import {
  applySplices,
  changesDigest,
  listChanges,
  type RenameProposal,
  type Splice,
  texFiles,
} from './labels.ts';
import { cutRevision, renameFile } from './revisions.ts';
import { loadUpdates } from './sync.ts';

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
 * Write a file the service itself makes, such as a drawn chart: the file at that path gets these
 * bytes, or is added. No permission check: the caller acts for the service.
 */
export async function putFile(
  db: Db,
  store: BlobStore,
  projectId: string,
  path: string,
  bytes: Uint8Array,
) {
  const digest = await store.put(bytes);
  const replaced = await db.query(
    'update files set digest = $3, size = $4 where project_id = $1 and path = $2 and eol is null',
    [projectId, path, digest, bytes.length],
  );
  if (!replaced.rowCount)
    await db.query(
      `insert into files (project_id, path, digest, size, readonly_reason) values ($1, $2, $3, $4, $5)`,
      [projectId, path, digest, bytes.length, fileMeta(path, bytes).readonly],
    );
  await db.query('update projects set manifest_version = manifest_version + 1 where id = $1', [
    projectId,
  ]);
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

/** `path` as written from the directory `dir` (which ends in a slash, or is empty). */
function relativeTo(dir: string, path: string) {
  const from = dir.split('/').filter(Boolean);
  const to = path.split('/');
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  return [...from.slice(same).map(() => '..'), ...to.slice(same)].join('/');
}

/** The lines that name a file (`\input`, `\bibliography`, `\includegraphics`...) and what they would say after it is renamed. */
async function renamePlan(
  db: Db,
  store: BlobStore,
  projectId: string,
  fileId: string,
  to: string,
  lock = false,
) {
  const files = await texFiles(db, store, projectId, lock);
  const all = (await db.query('select id, path from files where project_id = $1', [projectId]))
    .rows;
  const from: string | undefined = all.find((f) => f.id === fileId)?.path;
  if (!from) throw new AppError('not_found', 'No such file.');
  const paths = new Set<string>(all.map((f) => f.path));
  // TeX resolves every path against the root file's directory.
  const dir = rootDir(files.find((f) => f.root)?.path ?? '');
  const ext = (path: string) => /\.[^./]+$/.exec(path)?.[0] ?? '';
  const splices = new Map<string, Splice[]>();
  for (const file of files) {
    const hits: Splice[] = [];
    for (const inc of includes(file.text)) {
      if (resolveInclude(inc, dir, paths) !== from) continue;
      // Written without its extension before, and the extension has not changed: leave it off.
      const bare = !inc.target.endsWith(ext(from)) && ext(from) === ext(to);
      const insert = relativeTo(dir, bare ? to.slice(0, to.length - ext(to).length) : to);
      hits.push({ at: inc.targetAt, length: inc.target.length, insert });
    }
    if (hits.length) splices.set(file.id, hits);
  }
  const changes = listChanges(files, splices);
  const proposal: RenameProposal = {
    from,
    to,
    changes,
    digest: changesDigest([from, to], changes),
  };
  return { proposal, splices, files };
}

/**
 * What renaming a file would change in the files that name it. Nothing is changed. The new name
 * must be usable and free, as for the rename itself.
 */
export async function proposeFileRename(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId: string,
  to: unknown,
): Promise<RenameProposal> {
  await authorize(pool, userId, id(projectId), 'file.write');
  const problem = checkPath(to);
  if (problem) throw new AppError('invalid_input', `That name cannot be used: ${problem}.`);
  const plan = await renamePlan(pool, store, projectId, id(fileId), to as string);
  const taken = await pool.query(
    'select 1 from files where project_id = $1 and path = $2 and id <> $3',
    [projectId, to, fileId],
  );
  if (taken.rows[0]) throw new AppError('conflict', 'Another file already has that name.');
  return plan.proposal;
}

/**
 * Rename a file and, in the same transaction, the lines that name it. `digest` is the
 * proposal's: if the lines would now differ, nothing is done. With no digest only the file is
 * renamed, and the lines that name it are left as they are.
 */
export async function renameFileAndReferences(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId: string,
  to: unknown,
  digest?: unknown,
): Promise<{ places: number }> {
  await authorize(pool, userId, id(projectId), 'file.write');
  if (digest === undefined) {
    await renameFile(pool, userId, projectId, fileId, to);
    return { places: 0 };
  }
  // Makes sure each file's uploaded bytes are in its log as the first entry.
  for (const f of await texFiles(pool, store, projectId)) await loadUpdates(pool, store, f.id);
  return transaction(pool, async (db) => {
    // The plan is made from the old name, with the files held, and then the name changes.
    const plan = await renamePlan(db, store, projectId, id(fileId), String(to), true);
    await renameFile(db, userId, projectId, fileId, to);
    if (plan.proposal.digest !== digest)
      throw new AppError('conflict', 'The paper has changed since. Look at the changes again.');
    return { places: await applySplices(db, userId, plan.splices) };
  });
}

/** Pictures a browser can show as they are. A PDF or EPS figure is real, but not showable here. */
const SHOWN: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/**
 * The picture an `\\includegraphics` names, as LaTeX would find it: against the root file's
 * folder, with the extension added if it was left off. For showing in the editor.
 */
export async function picture(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  target: string,
): Promise<{ bytes: Uint8Array; type: string; path: string }> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select f.path, f.digest, p.root_file_id = f.id as root from files f
     join projects p on p.id = f.project_id where f.project_id = $1`,
    [projectId],
  );
  const dir = rootDir(rows.find((f) => f.root)?.path ?? '');
  const path = resolveInclude(
    { kind: 'graphics', target, dynamic: /[\\#]/.test(target), at: 0, targetAt: 0 },
    dir,
    new Set<string>(rows.map((f) => f.path)),
  );
  const type = SHOWN[path?.split('.').pop()?.toLowerCase() ?? ''];
  const bytes = type && (await store.get(rows.find((f) => f.path === path).digest));
  if (!path || !bytes) throw new AppError('not_found', 'No picture of that name can be shown.');
  return { bytes, type, path };
}

/** The paper's pictures, each as an `\\includegraphics` in it would name it. */
export async function pictures(db: Db, userId: string, projectId: string) {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select f.path, p.root_file_id = f.id as root from files f
     join projects p on p.id = f.project_id where f.project_id = $1 order by f.path`,
    [projectId],
  );
  const dir = rootDir(rows.find((f) => f.root)?.path ?? '');
  return rows
    .filter((f) => /\.(png|jpe?g|pdf|eps)$/i.test(f.path) && !f.root)
    .map((f) => ({ path: f.path as string, target: relativeTo(dir, f.path) }));
}
