// A paper's bibliography: the entries in its .bib files and the citations in its text, read
// from both as they stand now. Nothing here writes to a .bib file.
import { bibEntries, citeIndex, describeEntry, includeGraph } from '@paperweave/latex';
import type pg from 'pg';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { texFiles } from './labels.ts';
import { id } from './projects.ts';

type Place = { fileId: string; path: string; line: number };
export type BibliographyEntry = Place & {
  key: string;
  type: string;
  /** "Shapiro et al. 2011. Conflict-Free Replicated Data Types". */
  description: string;
  doi: string | null;
};
export type CitationReport = {
  entries: BibliographyEntry[];
  /** Citations of a key no entry has. The PDF shows [?] for these. */
  missing: (Place & { key: string; command: string })[];
  /** Keys that more than one entry has. BibTeX keeps one and warns. */
  duplicates: { key: string; places: Place[] }[];
  /** The citation command the paper uses most, without its backslash: what an insert should use. */
  command: string;
};

export async function citationReport(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<CitationReport> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const line = (text: string, at: number) => text.slice(0, at).split('\n').length;
  const report: CitationReport = { entries: [], missing: [], duplicates: [], command: 'cite' };
  for (const file of await texFiles(pool, store, projectId, false, '\\.bib$'))
    for (const e of bibEntries(file.text))
      report.entries.push({
        key: e.key,
        type: e.type,
        description: describeEntry(e),
        doi: e.fields.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') || null,
        fileId: file.id,
        path: file.path,
        line: line(file.text, e.at),
      });
  const byKey = new Map<string, BibliographyEntry[]>();
  for (const e of report.entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  for (const [key, entries] of byKey)
    if (entries.length > 1)
      report.duplicates.push({
        key,
        places: entries.map(({ fileId, path, line }) => ({ fileId, path, line })),
      });

  // Citations count only where the root file reaches. A paper with no root: every file.
  const tex = await texFiles(pool, store, projectId);
  const root = tex.find((f) => f.root);
  const reached = root
    ? includeGraph(Object.fromEntries(tex.map((f) => [f.path, f.text])), root.path).order
    : tex.map((f) => f.path);
  const uses = new Map<string, number>();
  for (const path of reached) {
    const file = tex.find((f) => f.path === path);
    for (const c of file ? citeIndex(file.text) : []) {
      uses.set(c.command, (uses.get(c.command) ?? 0) + 1);
      if (!byKey.has(c.key))
        report.missing.push({
          key: c.key,
          command: c.command,
          fileId: file!.id,
          path,
          line: line(file!.text, c.at),
        });
    }
  }
  // \nocite puts an entry in the list without citing it in the text: never what to insert.
  uses.delete('nocite');
  report.command = [...uses].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'cite';
  return report;
}
