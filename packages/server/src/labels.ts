// A paper's labels and the references to them, read from the text as it stands now.
import { createHash } from 'node:crypto';
import { decodeFile, includeGraph, labelIndex } from '@paperweave/latex';
import type pg from 'pg';
import * as Y from 'yjs';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { appendUpdate, currentBytes, loadUpdates, TEXT } from './sync.ts';

export type LabelPlace = { key: string; fileId: string; path: string; line: number };
export type LabelReport = {
  /** Every label: the root file's first, then each file it includes, in the order included. */
  labels: LabelPlace[];
  /** References to a label that is nowhere in the paper. LaTeX prints ?? for these. */
  undefined: (LabelPlace & { command: string })[];
  /** Keys given to more than one label. LaTeX uses the last and warns. */
  duplicates: { key: string; places: LabelPlace[] }[];
};

/** The text of every editable .tex file of a paper, by path, with each file's ID. */
export async function texFiles(
  pool: Db,
  store: BlobStore,
  projectId: string,
  /** Hold the files' rows, so that nothing is typed into them until the transaction ends. */
  lock = false,
) {
  const { rows } = await pool.query(
    `select f.id, f.path, f.digest, f.eol, f.bom, f.head_seq, p.root_file_id = f.id as root
     from files f join projects p on p.id = f.project_id
     where f.project_id = $1 and f.eol is not null and f.path ~* '\\.(tex|ltx)$' order by f.path
     ${lock ? 'for update of f' : ''}`,
    [projectId],
  );
  const files: { id: string; path: string; root: boolean; text: string }[] = [];
  for (const f of rows) {
    const decoded = decodeFile(await currentBytes(pool, store, f));
    if (decoded.editable) files.push({ id: f.id, path: f.path, root: f.root, text: decoded.text });
  }
  return files;
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
    const place = (x: { key: string; at: number }) => ({
      key: x.key,
      fileId: file.id,
      path,
      line: file.text.slice(0, x.at).split('\n').length,
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

/** Where a label's name appears in the paper's files, and what each line would become. */
function plan(
  files: { id: string; path: string; text: string }[],
  from: string,
  to: string,
): { proposal: RenameProposal; splices: Map<string, { at: number; length: number }[]> } {
  const changes: RenameChange[] = [];
  const splices = new Map<string, { at: number; length: number }[]>();
  let defined = false;
  let taken = false;
  for (const file of files) {
    const found = labelIndex(file.text);
    defined ||= found.labels.some((l) => l.key === from);
    taken ||= found.labels.some((l) => l.key === to);
    const hits = [...found.labels, ...found.refs]
      .filter((x) => x.key === from)
      .map((x) => ({ at: x.keyAt, length: from.length }))
      .sort((a, b) => a.at - b.at);
    if (!hits.length) continue;
    splices.set(file.id, hits);
    // Line by line, so that two names on one line are shown as one change.
    const lines = file.text.split('\n');
    let start = 0;
    lines.forEach((before, i) => {
      const here = hits.filter((h) => h.at >= start && h.at < start + before.length + 1);
      let after = before;
      for (const h of [...here].reverse())
        after = after.slice(0, h.at - start) + to + after.slice(h.at - start + h.length);
      if (here.length)
        changes.push({ fileId: file.id, path: file.path, line: i + 1, before, after });
      start += before.length + 1;
    });
  }
  // Not `not_found`: that code is kept for papers and files a person may not see.
  if (!defined) throw new AppError('invalid_input', `There is no label called ${from}.`);
  if (taken) throw new AppError('conflict', `There is already a label called ${to}.`);
  const digest = createHash('sha256')
    .update(JSON.stringify([from, to, changes]))
    .digest('hex');
  return { proposal: { from, to, changes, digest }, splices };
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
        for (const h of [...hits].reverse()) {
          text.delete(h.at, h.length);
          text.insert(h.at, b);
        }
      });
      const seq = await appendUpdate(db, fileId, userId, Y.encodeStateAsUpdate(doc, before));
      if (seq === null) throw new AppError('permission_denied', 'You cannot edit this paper.');
      // Delivered when the transaction commits: open editors see every file change together.
      await db.query("select pg_notify('file_edits', $1)", [`${fileId}:${seq}`]);
      places += hits.length;
    }
    return { places };
  });
}
