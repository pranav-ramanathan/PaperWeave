// Adding and removing a paper's files, and choosing its root.
import {
  decodeFile,
  includeGraph,
  includes,
  type Include,
  norm,
  resolveVia,
  rootDir,
} from '@paperweave/latex';
import type pg from 'pg';
import {
  checkPath,
  clashMessage,
  type Limits,
  LIMITS,
  pathClash,
  SOURCE,
  texName,
} from './archive.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import {
  applySplices,
  changesDigest,
  graphicsFolders,
  listChanges,
  type RenameProposal,
  type Splice,
  texFiles,
} from './labels.ts';
import { cutRevision, renameFile, restoreEdits } from './revisions.ts';
import { editLocked, loadUpdates } from './sync.ts';

/** Extensions that hold text the editors can open. Everything else is kept as bytes. */
export const TEXT_FILE = new RegExp(
  `\\.(tex|ltx|bib|bst|cls|sty|bbx|cbx|def|cfg|clo|tikz|pgf|pdf_tex|dat|lua|ist|inc|fd|ldf|csv|tsv|txt|md|${SOURCE})$`,
  'i',
);

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
  limits: Limits = LIMITS,
): Promise<string> {
  await authorize(db, userId, id(projectId), 'file.write');
  const problem = checkPath(path);
  if (problem) throw new AppError('invalid_input', `That name cannot be used: ${problem}.`);
  const tex = texName(path as string);
  if (tex) throw new AppError('invalid_input', tex);
  if (bytes.length > limits.fileBytes)
    throw new AppError('invalid_input', 'That file is too large.');
  const clash = pathClash(
    path as string,
    (await db.query('select path from files where project_id = $1', [projectId])).rows.map(
      (r) => r.path,
    ),
  );
  if (clash) throw new AppError('invalid_input', clashMessage(clash));
  // The same limits as an imported paper: how many files, and what they add up to. A file's
  // size is what it was added with, or for text edited since, what it came to at the paper's
  // newest revision; text typed since then is held to its own limit.
  const held = (
    await db.query(
      'select count(*)::int as n, coalesce(sum(size), 0)::float8 as bytes from files where project_id = $1',
      [projectId],
    )
  ).rows[0];
  if (held.n >= limits.files) throw new AppError('invalid_input', 'This paper has too many files.');
  if (held.bytes + bytes.length > limits.totalBytes)
    throw new AppError(
      'invalid_input',
      `This paper is full: its files can add up to ${Math.round(limits.totalBytes / 1e6)} MB.`,
    );
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
        throw new AppError(
          'conflict',
          'Another file already has that name. Tick "Replace the file of this name" to put this file in its place.',
        );
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
 * Put new bytes in the place of the file at `path`, keeping the file's ID, so that whatever is
 * tied to it (a dataset's description, the charts drawn from it) stays tied. The paper is saved
 * as a revision first, in the same transaction, so the old content is always kept. Text that
 * people may have open is changed by edits, as a restore does, so they see it at once. A path
 * with no file is added as a new file. Returns the file's ID.
 */
export async function replaceFile(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  path: unknown,
  bytes: Uint8Array,
  limits: Limits = LIMITS,
): Promise<string> {
  await authorize(pool, userId, id(projectId), 'file.write');
  const problem = checkPath(path);
  if (problem) throw new AppError('invalid_input', `That name cannot be used: ${problem}.`);
  const name = path as string;
  if (bytes.length > limits.fileBytes)
    throw new AppError('invalid_input', 'That file is too large.');
  const paths: string[] = (
    await pool.query('select path from files where project_id = $1', [projectId])
  ).rows.map((r) => r.path);
  if (!paths.includes(name)) {
    if (paths.some((p) => p.startsWith(`${name}/`)))
      throw new AppError('invalid_input', `${name} is a folder, and cannot be replaced by a file.`);
    return createFile(pool, store, userId, projectId, name, bytes, limits);
  }
  const meta = fileMeta(name, bytes);
  const digest = await store.put(bytes);
  let fileId = '';
  await cutRevision(pool, store, userId, projectId, {
    within: async (db) => {
      // Asked again with the files held: a role lowered while this waited is in force.
      await authorize(db, userId, id(projectId), 'file.write');
      const file = (
        await db.query(
          `select id, size, eol, head_seq from files where project_id = $1 and path = $2`,
          [projectId, name],
        )
      ).rows[0];
      if (!file)
        throw new AppError('conflict', 'The file was removed while it was being replaced.');
      fileId = file.id;
      if (file.eol && meta.readonly)
        throw new AppError(
          'invalid_input',
          `${name} is text that can be edited, and the new file cannot be read as text (${meta.readonly}). It was not replaced.`,
        );
      const total = (
        await db.query(
          'select coalesce(sum(size), 0)::float8 as bytes from files where project_id = $1',
          [projectId],
        )
      ).rows[0].bytes;
      if (total - file.size + bytes.length > limits.totalBytes)
        throw new AppError(
          'invalid_input',
          `This paper is full: its files can add up to ${Math.round(limits.totalBytes / 1e6)} MB.`,
        );
      if (file.eol && Number(file.head_seq) > 0) {
        const decoded = decodeFile(bytes);
        if (!decoded.editable)
          throw new AppError('invalid_input', 'The new file cannot be read as text.');
        const want = decoded.text;
        await editLocked(db, store, file.id, userId, (text) => {
          for (const e of restoreEdits(text.toString(), want)) {
            if (e.del) text.delete(e.at, e.del);
            if (e.ins) text.insert(e.at, e.ins);
          }
        });
      }
      // The digest is what an untouched file is read from; a file with edits is read from its
      // log, with the newline style and byte order mark set here.
      await db.query(
        `update files set digest = $2, size = $3, eol = $4, bom = $5, readonly_reason = $6
         where id = $1`,
        [file.id, digest, bytes.length, meta.eol, meta.bom, meta.readonly],
      );
      await db.query('update projects set manifest_version = manifest_version + 1 where id = $1', [
        projectId,
      ]);
    },
  });
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
  // The same refusal as adding a file by hand: a file and a folder cannot share a name.
  const clash = pathClash(
    path,
    (await db.query('select path from files where project_id = $1', [projectId])).rows.map(
      (r) => r.path,
    ),
  );
  if (clash) throw new AppError('invalid_input', clashMessage(clash));
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
  return digest;
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
       where f.id = $1 and f.project_id = $2 and f.deleted_at is null`,
      [id(fileId), projectId],
    )
  ).rows[0];
  if (!file) throw new AppError('not_found', 'No such file.');
  if (file.root)
    throw new AppError('invalid_input', 'This is the root file. Make another file the root first.');
  // The revision and the removal are one transaction. Edits that waited for the files while the
  // revision was cut would otherwise land before the removal, be acknowledged, and be in no
  // revision. Everything is checked again here, with the files held: the paper may have changed.
  const saved = await cutRevision(pool, store, userId, projectId, {
    within: async (db) => {
      await authorize(db, userId, id(projectId), 'file.write');
      const now = (
        await db.query(
          `select p.root_file_id = f.id as root from files f join projects p on p.id = f.project_id
           where f.id = $1 and f.project_id = $2 and f.deleted_at is null`,
          [id(fileId), projectId],
        )
      ).rows[0];
      if (!now) throw new AppError('not_found', 'No such file.');
      if (now.root)
        throw new AppError(
          'invalid_input',
          'This is the root file. Make another file the root first.',
        );
      await removeFile(db, projectId, fileId);
    },
  });
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

/**
 * Make a .tex file the one the paper is built from. The files are held first and the paper
 * after, the order a delete's revision takes: the other order deadlocks with it, through the
 * root's foreign key. The file is checked again with them held, so a file that was just
 * deleted is not found, rather than made the root.
 */
export async function setRootFile(
  pool: pg.Pool,
  userId: string,
  projectId: string,
  fileId: string,
) {
  await authorize(pool, userId, id(projectId), 'file.write');
  await transaction(pool, async (db) => {
    await db.query('select id from files where project_id = $1 order by path for update', [
      projectId,
    ]);
    // Asked again with the files held: a role lowered while this waited is in force.
    await authorize(db, userId, id(projectId), 'file.write');
    const { rowCount } = await db.query(
      `update projects set root_file_id = $2, manifest_version = manifest_version + 1
       where id = $1 and exists (
         select 1 from files where id = $2 and project_id = $1 and eol is not null and path ~* '\\.(tex|ltx)$'
       )`,
      [projectId, id(fileId)],
    );
    if (rowCount) return;
    const gone = await db.query(
      'select 1 from all_files where id = $1 and project_id = $2 and deleted_at is not null',
      [id(fileId), projectId],
    );
    if (gone.rowCount) throw new AppError('not_found', 'No such file.');
    throw new AppError('invalid_input', 'Only a .tex file of this paper can be the root.');
  });
}

/** `path` as written from the directory `dir` (which ends in a slash, or is empty). */
function relativeTo(dir: string, path: string) {
  const from = dir.split('/').filter(Boolean);
  const to = path.split('/');
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  return [...from.slice(same).map(() => '..'), ...to.slice(same)].join('/');
}

/**
 * What to replace in the line of an include so that it names `path` (as written from the root's
 * folder). A path written in two groups, `\\import{dir}{file}`, is replaced group by group: the
 * folder keeps its trailing slash, or lack of one, and a group that says the same is left alone.
 */
export function nameSplices(inc: Include, path: string): Splice[] {
  if (!inc.import) return [{ at: inc.targetAt, length: inc.target.length, insert: path }];
  const { dir, dirAt, file } = inc.import;
  const cut = path.lastIndexOf('/') + 1;
  let newDir = path.slice(0, cut);
  if (dir && !dir.endsWith('/')) newDir = newDir.replace(/\/$/, '');
  const out: Splice[] = [];
  if (newDir !== dir) out.push({ at: dirAt, length: dir.length, insert: newDir });
  if (path.slice(cut) !== file)
    out.push({ at: inc.targetAt, length: file.length, insert: path.slice(cut) });
  return out;
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
  const rootFile = files.find((f) => f.root);
  const dir = rootDir(rootFile?.path ?? '');
  const texts = Object.fromEntries(files.map((f) => [f.path, f.text]));
  const via = await graphicsFolders(db, store, projectId, rootFile?.path ?? '', paths, lock);
  const ext = (path: string) => /\.[^./]+$/.exec(path)?.[0] ?? '';
  const splices = new Map<string, Splice[]>();
  const { base } = includeGraph(texts, rootFile?.path ?? '', [...paths]);
  for (const file of files) {
    const hits: Splice[] = [];
    const inBase = base[file.path] ?? '';
    for (const inc of includes(file.text)) {
      // As includeGraph looks: the import folder first, then the root's folder.
      const underBase =
        inc.kind !== 'bib' && inBase ? resolveVia(inc, dir + inBase, paths) : undefined;
      const found = underBase ?? resolveVia(inc, dir, paths, via);
      if (found?.path !== from) continue;
      // Written without its extension before, and the extension has not changed: leave it off.
      // TeX adds .sty, .cls and .bst itself, so a new name for one is written without it.
      const bare = inc.ext
        ? to.endsWith(inc.ext)
        : !inc.target.endsWith(ext(from)) && ext(from) === ext(to);
      const newPath = bare ? to.slice(0, to.length - ext(to).length) : to;
      // Found through a \\graphicspath folder: say it as relative to that folder, if it is
      // still inside it. Otherwise relative to the root's folder, which always works.
      const folder = dir + found.via;
      // Found in the import folder: say it from there, as TeX looks there first. A sub-import's
      // folder group is relative to it, and may climb out with `..`. Any other include that
      // would leave the folder is written from the root, which TeX falls back to; a same-named
      // file inside the import folder would shadow it, and that is not checked.
      const insert = underBase
        ? inc.import?.sub || newPath.startsWith(dir + inBase)
          ? relativeTo(dir + inBase, newPath)
          : relativeTo(dir, newPath)
        : found.via && newPath.startsWith(norm(folder) + '/')
          ? newPath.slice(norm(folder).length + 1)
          : relativeTo(dir, newPath);
      hits.push(...nameSplices(inc, insert));
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
  const tex = texName(to as string);
  if (tex) throw new AppError('invalid_input', tex);
  const plan = await renamePlan(pool, store, projectId, id(fileId), to as string);
  const taken = await pool.query(
    'select 1 from files where project_id = $1 and path = $2 and id <> $3',
    [projectId, to, fileId],
  );
  if (taken.rows[0]) throw new AppError('conflict', 'Another file already has that name.');
  const others = await pool.query('select path from files where project_id = $1 and id <> $2', [
    projectId,
    fileId,
  ]);
  const clash = pathClash(
    to as string,
    others.rows.map((r) => r.path),
  );
  if (clash) throw new AppError('invalid_input', clashMessage(clash));
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
 * folder, with the extension added if it was left off. For showing in the editor. This is
 * the lookup, after the check that the person may read the paper: the stored version's digest.
 */
export async function pictureDigest(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  target: string,
): Promise<{ digest: string; type: string; path: string }> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select f.path, f.digest, p.root_file_id = f.id as root from files f
     join projects p on p.id = f.project_id where f.project_id = $1`,
    [projectId],
  );
  const dir = rootDir(rows.find((f) => f.root)?.path ?? '');
  const rootFile = (await texFiles(db, store, projectId)).find((f) => f.root);
  const path = resolveVia(
    { kind: 'graphics', target, dynamic: /[\\#]/.test(target), at: 0, targetAt: 0 },
    dir,
    new Set<string>(rows.map((f) => f.path)),
    await graphicsFolders(
      db,
      store,
      projectId,
      rootFile?.path ?? '',
      rows.map((f) => f.path),
    ),
  )?.path;
  // A PDF cannot be shown as it is. A drawn chart has a PNG of the same name beside it: that is
  // shown in its place.
  const twin = path?.replace(/\.pdf$/i, '.png');
  const shown = rows.find((f) => f.path === twin) ? twin : path;
  const type = SHOWN[shown?.split('.').pop()?.toLowerCase() ?? ''];
  if (!path || !type) throw new AppError('not_found', 'No picture of that name can be shown.');
  return { digest: rows.find((f) => f.path === shown).digest, type, path };
}

/** The picture `pictureDigest` finds, with its bytes. */
export async function picture(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  target: string,
): Promise<{ bytes: Uint8Array; type: string; path: string }> {
  const { digest, type, path } = await pictureDigest(db, store, userId, projectId, target);
  const bytes = await store.get(digest);
  if (!bytes) throw new AppError('not_found', 'No picture of that name can be shown.');
  return { bytes, type, path };
}

/**
 * The paper's pictures, each as an `\\includegraphics` in it would name it. A drawn chart is
 * offered once, as its PDF, with the caption and description its author gave it.
 */
export async function pictures(db: Db, userId: string, projectId: string) {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select f.path, p.root_file_id = f.id as root, c.caption, c.alt,
            c.id is not null and f.path like '%.png' as twin
     from files f join projects p on p.id = f.project_id
     left join charts c on c.project_id = f.project_id
       and f.path in ('charts/' || c.name || '.pdf', 'charts/' || c.name || '.png')
     where f.project_id = $1 order by f.path`,
    [projectId],
  );
  const dir = rootDir(rows.find((f) => f.root)?.path ?? '');
  return rows
    .filter((f) => /\.(png|jpe?g|pdf|eps)$/i.test(f.path) && !f.root && !f.twin)
    .map((f) => ({
      path: f.path as string,
      target: relativeTo(dir, f.path),
      ...(f.caption === null ? {} : { caption: f.caption as string, alt: f.alt as string }),
    }));
}
