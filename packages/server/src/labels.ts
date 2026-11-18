// A paper's labels and the references to them, read from the text as it stands now.
import { decodeFile, includeGraph, labelIndex } from '@paperweave/latex';
import type pg from 'pg';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { id } from './projects.ts';
import { currentBytes } from './sync.ts';

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
export async function texFiles(pool: pg.Pool, store: BlobStore, projectId: string) {
  const { rows } = await pool.query(
    `select f.id, f.path, f.digest, f.eol, f.bom, f.head_seq, p.root_file_id = f.id as root
     from files f join projects p on p.id = f.project_id
     where f.project_id = $1 and f.eol is not null and f.path ~* '\\.(tex|ltx)$' order by f.path`,
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
