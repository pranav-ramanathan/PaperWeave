// Warnings with one cause are one item, with every place they were found.
import type { Finding } from './submit.ts';

export type Placed = Finding & {
  places: { fileId?: string; path?: string; line?: number }[];
};

/**
 * Findings with the same level, kind and message become one, at the position of the first. A
 * chart finding is its own.
 */
export function byCause(findings: Finding[]): Placed[] {
  const out: Placed[] = [];
  const at = new Map<string, Placed>();
  for (const f of findings) {
    const place = f.path ? { fileId: f.fileId, path: f.path, line: f.line } : undefined;
    if (f.chartId) {
      out.push({ ...f, places: [] });
      continue;
    }
    const key = JSON.stringify([f.level, f.kind, f.message]);
    const had = at.get(key);
    if (!had) {
      const first: Placed = { ...f, places: place ? [place] : [] };
      at.set(key, first);
      out.push(first);
    } else if (
      place &&
      !had.places.some(
        (p) => p.fileId === place.fileId && p.path === place.path && p.line === place.line,
      )
    ) {
      had.places.push(place);
    }
  }
  return out;
}
