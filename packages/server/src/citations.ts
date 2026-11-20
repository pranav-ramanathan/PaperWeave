// A paper's bibliography: the entries in its .bib files and the citations in its text, read
// from both as they stand now. Nothing here writes to a .bib file.
import {
  bibEntries,
  bibItems,
  citeIndex,
  cleanDoi,
  describeEntry,
  includeGraph,
} from '@paperweave/latex';
import type pg from 'pg';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { lineNumbers, texFiles } from './labels.ts';
import { id } from './projects.ts';

type Place = { fileId: string; path: string; line: number };
export type BibliographyEntry = Place & {
  key: string;
  type: string;
  /** "Shapiro et al. 2011. Conflict-Free Replicated Data Types". */
  description: string;
  doi: string | null;
  /** Whether the paper names this key in a citation, \\nocite included, where its root reaches. */
  cited: boolean;
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
  const report: CitationReport = { entries: [], missing: [], duplicates: [], command: 'cite' };
  for (const file of await texFiles(pool, store, projectId, false, '\\.bib$')) {
    const line = lineNumbers(file.text);
    for (const e of bibEntries(file.text))
      report.entries.push({
        key: e.key,
        type: e.type,
        description: describeEntry(e),
        doi: cleanDoi(e) || null,
        cited: false,
        fileId: file.id,
        path: file.path,
        line: line(e.at),
      });
  }
  // Citations count, and \bibitem entries are read, only where the root file reaches.
  // A paper with no root: every file.
  const tex = await texFiles(pool, store, projectId);
  const root = tex.find((f) => f.root);
  const reached = root
    ? includeGraph(Object.fromEntries(tex.map((f) => [f.path, f.text])), root.path).order
    : tex.map((f) => f.path);
  // A hand-written thebibliography is a bibliography too: each \bibitem is an entry, described
  // by its text up to the next one, cut to one line.
  for (const path of reached) {
    const file = tex.find((f) => f.path === path);
    if (!file) continue;
    const line = lineNumbers(file.text);
    for (const i of bibItems(file.text))
      report.entries.push({
        key: i.key,
        type: 'bibitem',
        description: i.text.length > 160 ? `${i.text.slice(0, 159)}…` : i.text || i.key,
        doi: null,
        cited: false,
        fileId: file.id,
        path,
        line: line(i.at),
      });
  }
  const byKey = new Map<string, BibliographyEntry[]>();
  for (const e of report.entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  for (const [key, entries] of byKey)
    if (entries.length > 1)
      report.duplicates.push({
        key,
        places: entries.map(({ fileId, path, line }) => ({ fileId, path, line })),
      });

  const uses = new Map<string, number>();
  const named = new Set<string>();
  for (const path of reached) {
    const file = tex.find((f) => f.path === path);
    const line = lineNumbers(file?.text ?? '');
    for (const c of file ? citeIndex(file.text) : []) {
      uses.set(c.command, (uses.get(c.command) ?? 0) + 1);
      named.add(c.key);
      if (!byKey.has(c.key))
        report.missing.push({
          key: c.key,
          command: c.command,
          fileId: file!.id,
          path,
          line: line(c.at),
        });
    }
  }
  for (const e of report.entries) e.cited = named.has(e.key);
  // \nocite puts an entry in the list without citing it in the text: never what to insert.
  uses.delete('nocite');
  report.command = [...uses].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'cite';
  return report;
}
