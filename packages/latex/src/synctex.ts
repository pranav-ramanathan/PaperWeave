// SyncTeX: where each line of the source landed in the PDF, as the TeX engine wrote it down
// while it built. Read here to go from a line to a place on a page, and back.
//
// The file lists, page by page, the boxes TeX made and the glue, kerns and maths in them, each
// with the file and line TeX was reading when it made it. Characters themselves are not listed,
// so a place in a paragraph is known to the nearest space.

export type SyncRecord = {
  page: number;
  /** Index into `inputs`. */
  file: number;
  line: number;
  /** PDF points from the page's top-left corner; `y` is the baseline. */
  x: number;
  y: number;
  w: number;
  /** Height above the baseline and depth below it. */
  h: number;
  d: number;
  /** A horizontal box: a line of text or part of one. Otherwise something inside a box. */
  box: boolean;
  /** The record's letter: `(` box, `h` and `v` boxes, `x` current, `k` kern, `g` glue, `$` maths. */
  kind: string;
  /**
   * Said nothing of where its words were typed. TeX tags a paragraph's line boxes, and what it
   * puts at their start and end, with the line the paragraph ended on; so a box that holds a
   * record of another file or line is stale, and so are its records tagged as it is.
   */
  stale: boolean;
};
export type SyncTeX = {
  /** The paper's own files, as paths in the project. Class and package files are left out. */
  inputs: string[];
  records: SyncRecord[];
};

/** Scaled points in a PDF point. */
const SP = 65781.76;
const RECORD = /^([(hvxkg$])(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

/**
 * Read a SyncTeX file (already unzipped). `base` is the folder the build ran in: files under it
 * are the paper's, and are named by their path below it.
 */
export function parseSyncTeX(text: string, base = '/work/'): SyncTeX {
  const inputs: string[] = [];
  const tags = new Map<number, number>();
  const records: SyncRecord[] = [];
  let unit = 1;
  let offset = 0;
  let page = 0;
  // The boxes open now: what is directly inside each, to tell at its close if it is mixed.
  let open: { box: SyncRecord | null; kids: SyncRecord[] }[] = [];
  for (const line of text.split('\n')) {
    const c = line[0];
    if (c === 'I' && line.startsWith('Input:')) {
      const colon = line.indexOf(':', 6);
      const path = line.slice(colon + 1);
      if (!path.startsWith(base)) continue;
      // "/work/./sections/a.tex" is sections/a.tex; "/work/paper/../shared/a.tex" is shared/a.tex.
      const parts: string[] = [];
      for (const part of path.slice(base.length).split('/'))
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
      const name = parts.join('/');
      let at = inputs.indexOf(name);
      if (at < 0) at = inputs.push(name) - 1;
      tags.set(Number(line.slice(6, colon)), at);
    } else if (c === 'U' && line.startsWith('Unit:')) unit = Number(line.slice(5)) || 1;
    else if (c === 'M' && line.startsWith('Magnification:'))
      unit *= (Number(line.slice(14)) || 1000) / 1000;
    // An engine that writes a PDF itself counts from the page's corner. One that writes DVI
    // first counts from TeX's origin, an inch in from it.
    else if (c === 'O' && line.startsWith('Output:')) offset = line.slice(7) === 'pdf' ? 0 : 72.27;
    else if (c === '{') [page, open] = [Number(line.slice(1)), []];
    else if (page) {
      if (c === ')' || c === ']') {
        const done = open.pop();
        const b = done?.box;
        if (b && done.kids.some((k) => k.file !== b.file || k.line !== b.line)) {
          b.stale = true;
          for (const k of done.kids) if (k.file === b.file && k.line === b.line) k.stale = true;
        }
        continue;
      }
      const m = RECORD.exec(line);
      const file = m ? tags.get(Number(m[2])) : undefined;
      if (!m || file === undefined) {
        // A box of a class file or the like: its inside is nobody's, but it still closes.
        if (c === '(' || c === '[') open.push({ box: null, kids: [] });
        continue;
      }
      const pt = (v?: string) => (Number(v ?? 0) * unit) / SP;
      const record: SyncRecord = {
        page,
        file,
        line: Number(m[3]),
        x: pt(m[4]) + offset,
        y: pt(m[5]) + offset,
        w: pt(m[6]),
        h: pt(m[7]),
        d: pt(m[8]),
        box: m[1] === '(',
        kind: m[1],
        stale: false,
      };
      records.push(record);
      if (c === '(') open.push({ box: record, kids: [] });
      else if (c === '[') open.push({ box: null, kids: [] });
      else open.at(-1)?.kids.push(record);
    }
  }
  return { inputs, records };
}

/**
 * Where a line of a file is in the PDF: the page, and the box around what it made there. A line
 * that made nothing (a comment, a blank line) gives the next line that did.
 */
export function toPdf(sync: SyncTeX, path: string, line: number) {
  const file = sync.inputs.indexOf(path);
  if (file < 0) return null;
  // What a line only ended, or was stray in, is not what it made: a blank line that closed a
  // paragraph made nothing. (A file with nothing else is taken as it is.)
  const own = sync.records.filter((r) => r.file === file);
  const mine = own.some((r) => !r.stale) ? own.filter((r) => !r.stale) : own;
  let best = Infinity;
  for (const r of mine) if (r.line >= line && r.line < best) best = r.line;
  // Past the last line that made anything: the last one that did.
  if (best === Infinity) {
    best = -1;
    for (const r of mine) if (r.line > best) best = r.line;
  }
  const made = mine.filter((r) => r.line === best);
  if (!made.length) return null;
  // Where the line's own text begins: the first thing it put inside a box, on the first page it
  // reached. (Its boxes alone can span columns, or a whole float.)
  const page = Math.min(...made.map((r) => r.page));
  const here = made.filter((r) => r.page === page);
  const first = here.find((r) => !r.box) ?? here[0];
  // Glue and kerns have no height of their own: allow for a line of text.
  const up = Math.max(first.h, 8);
  return { page, x: first.x, y: first.y - up, height: up + Math.max(first.d, 2), line: best };
}

/** The paper's own records inside a line box, in the order TeX wrote them. */
function inside(on: SyncRecord[], box: SyncRecord) {
  return on.filter(
    (r) => !r.box && r.x >= box.x - 1 && r.x <= box.x + box.w + 1 && Math.abs(r.y - box.y) < 1,
  );
}

/** What a line box says about where its words were typed: its records that are not stale. */
function usable(on: SyncRecord[], box: SyncRecord) {
  const all = inside(on, box);
  const good = all.filter((r) => !r.stale);
  return good.length ? good : all;
}

/**
 * The file and line that made what is at a point of a page. Outside every line of text and more
 * than a margin from anything, it is nowhere, unless the nearest thing is asked for.
 */
export function toSource(sync: SyncTeX, page: number, x: number, y: number, nearest = false) {
  const on = sync.records.filter((r) => r.page === page);
  if (!on.length) return null;
  // The smallest box around the point. If it is a line of text, what was clicked is on that
  // line: this keeps to the right column, and to the right line of it. A taller box (a column,
  // a float) only says roughly where.
  let box: SyncRecord | null = null;
  for (const r of on)
    if (r.box && r.w > 0 && x >= r.x && x <= r.x + r.w && y >= r.y - r.h - 2 && y <= r.y + r.d + 2)
      if (!box || r.w * (r.h + r.d) < box.w * (box.h + box.d)) box = r;
  const text = box && box.h + box.d <= 30 ? box : null;
  const answer = (r: SyncRecord) => ({ path: sync.inputs[r.file], line: r.line });
  if (text) {
    // Reading order: the last record at or left of the click, else the first one to its right.
    let left: SyncRecord | null = null;
    let right: SyncRecord | null = null;
    for (const r of usable(on, text)) {
      if (r.x <= x) {
        if (!left || r.x >= left.x) left = r;
      } else if (!right || r.x < right.x) right = r;
    }
    const here = left ?? right;
    if (here) return answer(here);
    // The box holds nothing of its own: the line above in the same column, at its end.
    let above: SyncRecord | null = null;
    let last: SyncRecord | null = null;
    for (const b of on) {
      if (!b.box || b.w <= 0 || b.h + b.d > 30 || b.y >= text.y - 0.5) continue;
      if (b.x > text.x + text.w || b.x + b.w < text.x) continue;
      if (above && b.y <= above.y) continue;
      const u = usable(on, b);
      if (u.length) [above, last] = [b, u[u.length - 1]];
    }
    return last ? answer(last) : answer(text);
  }
  let found: SyncRecord | null = null;
  let near = Infinity;
  for (const r of on) {
    if (r.box) continue;
    if (box && (r.x < box.x - 1 || r.x > box.x + box.w + 1)) continue;
    const far = Math.hypot(r.x - x, (r.y - y) * 3);
    // Of two at the same place, the later is the one further in.
    if (far <= near) [found, near] = [r, far];
  }
  // Outside every box, beyond the margin of a line: the PDF does not say.
  if (!box && !nearest && near > MARGIN) return null;
  found ??= box;
  return found && answer(found);
}

/** How far from any record, in the weighted distance, a point outside every box still counts. */
const MARGIN = 36;
