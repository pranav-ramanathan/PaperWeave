// A paper's labels and the references to them, read from the text as it stands now.
import { createHash } from 'node:crypto';
import {
  decodeFile,
  includeGraph,
  labelIndex,
  macroDefs,
  projectGraphicsPaths,
  proseEnvs,
} from '@paperweave/latex';
import type pg from 'pg';
import * as Y from 'yjs';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { remembered } from './scope.ts';
import { appendUpdate, bytesOfLog, loadUpdates, readLogs, TEXT } from './sync.ts';

export type LabelPlace = { key: string; fileId: string; path: string; line: number };
export type LabelReport = {
  /** Every label: the root file's first, then each file it includes, in the order included. */
  labels: LabelPlace[];
  /** References to a label that is nowhere in the paper. LaTeX prints ?? for these. */
  undefined: (LabelPlace & { command: string })[];
  /** Keys given to more than one label. LaTeX uses the last and warns. */
  duplicates: { key: string; places: LabelPlace[] }[];
};

/**
 * Which line of a text each place in it is on, the first being 1. The lines are found once.
 * Asking for each place by reading the text from its top took seconds for a .bib file of
 * thousands of entries: every entry read everything above it again.
 */
export function lineNumbers(text: string): (at: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (at) => {
    // The last line that starts at or before the place.
    let low = 0;
    let high = starts.length;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= at) low = middle;
      else high = middle;
    }
    return low + 1;
  };
}

/** The text of every editable .tex file of a paper, by path, with each file's ID. */
export function texFiles(
  pool: Db,
  store: BlobStore,
  projectId: string,
  /** Hold the files' rows, so that nothing is typed into them until the transaction ends. */
  lock = false,
  /** Which files, by the end of their path. */
  ending = '\\.(tex|ltx)$',
) {
  // Locking is never answered from memory.
  if (lock) return readTexFiles(pool, store, projectId, true, ending);
  return remembered(pool, ['tex', projectId, ending], () =>
    readTexFiles(pool, store, projectId, false, ending),
  );
}

async function readTexFiles(
  pool: Db,
  store: BlobStore,
  projectId: string,
  lock: boolean,
  ending: string,
) {
  const { rows } = await pool.query(
    `select f.id, f.path, f.digest, f.eol, f.bom, f.head_seq, p.root_file_id = f.id as root
     from files f join projects p on p.id = f.project_id
     where f.project_id = $1 and f.eol is not null and f.path ~* $2 order by f.path
     ${lock ? 'for update of f' : ''}`,
    [projectId, ending],
  );
  // The first log entry is the upload itself, so a file is untouched until there is a second.
  // The logs of those that are edited come in one statement; the rest are read from the store.
  const edited = rows.filter((f) => Number(f.head_seq) > 1);
  const logs = await readLogs(
    pool,
    edited.map((f) => f.id),
  );
  const files: { id: string; path: string; root: boolean; text: string }[] = [];
  const bytesOf = async (f: (typeof rows)[number]) => {
    if (Number(f.head_seq) > 1) return bytesOfLog(f, logs.get(f.id) ?? []);
    const bytes = await store.get(f.digest);
    if (!bytes) throw new Error(`blob ${f.digest} is missing`);
    return bytes;
  };
  // Sixteen at a time. One after another, a paper of many files waits on the store once for
  // each, and every page of the paper reads them all.
  for (let i = 0; i < rows.length; i += 16) {
    const read = await Promise.all(
      rows.slice(i, i + 16).map(async (f) => decodeFile(await bytesOf(f))),
    );
    read.forEach((decoded, n) => {
      const f = rows[i + n];
      if (decoded.editable)
        files.push({ id: f.id, path: f.path, root: f.root, text: decoded.text });
    });
  }
  return files;
}

/**
 * The text of the .bbl a paper with no .bib file came with: the root's own (`main.tex` has
 * `main.bbl`, as \\jobname.bbl), or with no root, every one. A .bbl is generated, so it is
 * not in the editable files and is read as it was stored.
 */
export function bblFiles(pool: Db, store: BlobStore, projectId: string) {
  return remembered(pool, ['bbl', projectId], async () => {
    const { rows } = await pool.query(
      `select f.id, f.path, f.digest, (select r.path from files r where r.id = p.root_file_id) as root_path
       from files f join projects p on p.id = f.project_id
       where f.project_id = $1 and f.path ~* '\\.bbl$'
         and not exists (select 1 from files b where b.project_id = f.project_id and b.path ~* '\\.bib$')
       order by f.path`,
      [projectId],
    );
    const wanted = rows[0]?.root_path
      ? `${String(rows[0].root_path).replace(/\.(tex|ltx)$/i, '')}.bbl`
      : null;
    const files: { id: string; path: string; text: string }[] = [];
    for (const f of rows) {
      if (wanted && f.path !== wanted) continue;
      const bytes = await store.get(f.digest);
      if (!bytes) throw new Error(`blob ${f.digest} is missing`);
      const decoded = decodeFile(bytes);
      files.push({
        id: f.id,
        path: f.path,
        text: decoded.editable ? decoded.text : Buffer.from(bytes).toString('latin1'),
      });
    }
    return files;
  });
}

export async function labelReport(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<LabelReport> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const files = await texFiles(pool, store, projectId);
  // Only what the root file reaches is part of the paper. A paper with no root: every file.
  const root = files.find((f) => f.root);
  const reached = root
    ? includeGraph(Object.fromEntries(files.map((f) => [f.path, f.text])), root.path).order
    : files.map((f) => f.path);
  const report: LabelReport = { labels: [], undefined: [], duplicates: [] };
  const refs: LabelReport['undefined'] = [];
  for (const path of reached) {
    const file = files.find((f) => f.path === path);
    if (!file) continue;
    const found = labelIndex(file.text);
    const line = lineNumbers(file.text);
    const place = (x: { key: string; at: number }) => ({
      key: x.key,
      fileId: file.id,
      path,
      line: line(x.at),
    });
    for (const l of found.labels) report.labels.push(place(l));
    for (const r of found.refs) refs.push({ ...place(r), command: r.command });
  }
  const byKey = new Map<string, LabelPlace[]>();
  for (const l of report.labels) byKey.set(l.key, [...(byKey.get(l.key) ?? []), l]);
  report.undefined = refs.filter((r) => !byKey.has(r.key));
  for (const [key, places] of byKey) if (places.length > 1) report.duplicates.push({ key, places });
  return report;
}

/**
 * The simple macros the paper defines before its text begins: in the root file's preamble and in
 * the files that preamble reads. The editor gives them to its maths renderer.
 */
export async function paperMacros(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<Record<string, string>> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const files = await texFiles(pool, store, projectId);
  const root = files.find((f) => f.root);
  if (!root) return {};
  const texts = Object.fromEntries(files.map((f) => [f.path, f.text]));
  const begins = root.text.indexOf('\\begin{document}');
  const preamble = begins < 0 ? root.text : root.text.slice(0, begins);
  // In the order TeX reads them, so that a later definition of a name wins.
  let macros = macroDefs(preamble);
  for (const path of includeGraph(texts, root.path).preamble)
    macros = { ...macros, ...macroDefs(texts[path] ?? '') };
  return macros;
}

/**
 * The environments the paper declares as theorems (`\\newtheorem{observation}`), which the
 * editor treats as prose. Read from the root's preamble, the files it reads and the project's own
 * packages it loads (`proseEnvs`).
 */
export async function paperProse(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<string[]> {
  await authorize(pool, userId, id(projectId), 'project.read');
  return proseOf(pool, store, projectId);
}

/** `paperProse` for a caller that has already checked the person's access. */
export async function proseOf(pool: Db, store: BlobStore, projectId: string): Promise<string[]> {
  const files = await texFiles(pool, store, projectId, false, '\\.(tex|ltx|sty|cls)$');
  const root = files.find((f) => f.root);
  if (!root) return [];
  return proseEnvs(Object.fromEntries(files.map((f) => [f.path, f.text])), root.path);
}

/**
 * The `\\graphicspath` folders the paper sets, in its root's preamble, the files that read and
 * its own packages and classes (`projectGraphicsPaths`). `paths` is every path of the project.
 */
export async function graphicsFolders(
  pool: Db,
  store: BlobStore,
  projectId: string,
  root: string,
  paths: Iterable<string>,
  lock = false,
): Promise<string[]> {
  const files = await texFiles(pool, store, projectId, lock, '\\.(tex|ltx|sty|cls)$');
  return projectGraphicsPaths(
    Object.fromEntries(files.map((f) => [f.path, f.text])),
    root,
    new Set(paths),
  );
}

/** One line that a rename would change, before and after. */
export type RenameChange = {
  fileId: string;
  path: string;
  line: number;
  before: string;
  after: string;
};
export type RenameProposal = {
  from: string;
  to: string;
  changes: RenameChange[];
  /** Stands for exactly this set of changes. Sent back to carry them out. */
  digest: string;
};

/** Replace `length` characters at `at` with `insert`. */
export type Splice = { at: number; length: number; insert: string };
type TexFile = { id: string; path: string; text: string };

/** The lines a set of splices would change, before and after, file by file. */
export function listChanges(files: TexFile[], splices: Map<string, Splice[]>): RenameChange[] {
  const changes: RenameChange[] = [];
  for (const file of files) {
    const hits = splices.get(file.id);
    if (!hits) continue;
    // Line by line, so that two changes on one line are shown as one.
    let start = 0;
    file.text.split('\n').forEach((before, i) => {
      const here = hits.filter((h) => h.at >= start && h.at < start + before.length + 1);
      let after = before;
      for (const h of [...here].sort((x, y) => y.at - x.at))
        after = after.slice(0, h.at - start) + h.insert + after.slice(h.at - start + h.length);
      if (here.length)
        changes.push({ fileId: file.id, path: file.path, line: i + 1, before, after });
      start += before.length + 1;
    });
  }
  return changes;
}

/**
 * Make the splices, as the user, in a transaction that already holds the files. Each file's edit
 * goes through its log like any other, and reaches open editors when the transaction commits.
 */
export async function applySplices(db: Db, userId: string, splices: Map<string, Splice[]>) {
  let places = 0;
  for (const [fileId, hits] of splices) {
    const doc = new Y.Doc();
    const { rows } = await db.query(
      'select update from file_updates where file_id = $1 order by seq',
      [fileId],
    );
    for (const r of rows) Y.applyUpdate(doc, new Uint8Array(r.update));
    const text = doc.getText(TEXT);
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      for (const h of [...hits].sort((x, y) => y.at - x.at)) {
        text.delete(h.at, h.length);
        text.insert(h.at, h.insert);
      }
    });
    const seq = await appendUpdate(db, fileId, userId, Y.encodeStateAsUpdate(doc, before));
    if (seq === null) throw new AppError('permission_denied', 'You cannot edit this paper.');
    await db.query("select pg_notify('file_edits', $1)", [`${fileId}:${seq}`]);
    places += hits.length;
  }
  return places;
}

/** What stands for exactly one set of changes: sent with a proposal, and back to carry it out. */
export const changesDigest = (what: unknown[], changes: RenameChange[]) =>
  createHash('sha256')
    .update(JSON.stringify([...what, changes]))
    .digest('hex');

/** Where a label's name appears in the paper's files, and what each line would become. */
function plan(
  files: TexFile[],
  from: string,
  to: string,
): { proposal: RenameProposal; splices: Map<string, Splice[]> } {
  const splices = new Map<string, Splice[]>();
  let defined = false;
  let taken = false;
  for (const file of files) {
    const found = labelIndex(file.text);
    defined ||= found.labels.some((l) => l.key === from);
    taken ||= found.labels.some((l) => l.key === to);
    const hits = [...found.labels, ...found.refs]
      .filter((x) => x.key === from)
      .map((x) => ({ at: x.keyAt, length: from.length, insert: to }));
    if (hits.length) splices.set(file.id, hits);
  }
  // Not `not_found`: that code is kept for papers and files a person may not see.
  if (!defined) throw new AppError('invalid_input', `There is no label called ${from}.`);
  if (taken) throw new AppError('conflict', `There is already a label called ${to}.`);
  const changes = listChanges(files, splices);
  return { proposal: { from, to, changes, digest: changesDigest([from, to], changes) }, splices };
}

function names(from: unknown, to: unknown): [string, string] {
  if (typeof from !== 'string' || !from) throw new AppError('invalid_input', 'Choose a label.');
  // What LaTeX accepts in a label and what survives being typed into a \ref list.
  if (typeof to !== 'string' || !/^[^\s{}\\%#~,^$&]{1,200}$/.test(to))
    throw new AppError(
      'invalid_input',
      'A label name is 1 to 200 characters, with no spaces, commas, braces or LaTeX special characters.',
    );
  if (from === to) throw new AppError('invalid_input', 'That is already its name.');
  return [from, to];
}

/** What renaming a label would change: the label itself and every reference to it, in every file. */
export async function proposeLabelRename(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  from: unknown,
  to: unknown,
): Promise<RenameProposal> {
  await authorize(pool, userId, id(projectId), 'file.write');
  return plan(await texFiles(pool, store, projectId), ...names(from, to)).proposal;
}

/**
 * Carry out a proposed rename, in every file at once or not at all. `digest` is the proposal's:
 * if the text has changed since it was made so that the changes would differ, nothing is done.
 */
export async function renameLabel(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  from: unknown,
  to: unknown,
  digest: unknown,
): Promise<{ places: number }> {
  await authorize(pool, userId, id(projectId), 'file.write');
  const [a, b] = names(from, to);
  // Makes sure each file's uploaded bytes are in its log as the first entry.
  for (const f of await texFiles(pool, store, projectId)) await loadUpdates(pool, store, f.id);
  return transaction(pool, async (db) => {
    // The files are held from here on: what is checked is what is changed.
    const { proposal, splices } = plan(await texFiles(db, store, projectId, true), a, b);
    if (proposal.digest !== digest)
      throw new AppError('conflict', 'The paper has changed since. Look at the changes again.');
    // Delivered when the transaction commits: open editors see every file change together.
    return { places: await applySplices(db, userId, splices) };
  });
}
