// A line diff for showing what changed between two revisions of a file.

export type DiffLine = { op: ' ' | '+' | '-'; text: string };

/**
 * The items of `x` and `y` as kept, removed and added, in order. Returns null if the changed
 * region is larger than `maxCells` table cells.
 * shortcut: a plain longest-common-subsequence table, quadratic in the changed region. Fine for
 * papers and proposals; switch to Myers' algorithm if files of tens of thousands of changed
 * lines or words turn up.
 */
function diffSeq(x: string[], y: string[], maxCells: number): DiffLine[] | null {
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const n = endX - start;
  const m = endY - start;
  if (n * m > maxCells) return null;
  // lcs[i][j]: length of the longest common subsequence of x[start+i..] and y[start+j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        x[start + i] === y[start + j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: DiffLine[] = x.slice(0, start).map((text) => ({ op: ' ', text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[start + i] === y[start + j]) {
      out.push({ op: ' ', text: x[start + i] });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1]))
      // On a tie the removal comes first, the way people read a change: old line, then new.
      out.push({ op: '-', text: x[start + i++] });
    else out.push({ op: '+', text: y[start + j++] });
  }
  for (const text of x.slice(endX)) out.push({ op: ' ', text });
  return out;
}

/**
 * The lines of `a` and `b` as kept, removed and added, in order. Returns null if the files are too
 * large to compare line by line here.
 */
export function diffLines(a: string, b: string, maxCells = 4_000_000): DiffLine[] | null {
  return diffSeq(a.split('\n'), b.split('\n'), maxCells);
}

/**
 * All the lines of a file that is only on one side of a comparison, every one added (`+`) or
 * removed (`-`), in the shape `diffLines` gives so that `diffHunks` takes them unchanged. At most
 * `max` lines are given; `more` is how many were left out. The newline that ends the last line
 * does not start another, and an empty text has no lines.
 */
export function wholeFile(
  text: string,
  op: '+' | '-',
  max: number,
): { lines: DiffLine[]; more: number } {
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  const shown = all.slice(0, Math.max(0, max));
  return { lines: shown.map((line) => ({ op, text: line })), more: all.length - shown.length };
}

/** The most lines `diffLinesFar` will report as removed and added together. */
export const FAR_EDITS = 2000;

/** How many comparisons of two lines `diffLinesFar` may make before it declines. */
const FAR_STEPS = 20_000_000;

/**
 * `diffLines`, and where that declines because the changes lie too far apart for its table, the
 * same answer found another way (Myers' shortest edit script), whose cost grows with the number
 * of changed lines and not with the distance between them. Still null when more than `maxEdits`
 * lines were removed and added together, or the work passes `maxSteps`.
 * Used by the restore (`restoreEdits`), the PDF's line map (`lineMap`) and the revision diff.
 */
export function diffLinesFar(
  a: string,
  b: string,
  maxCells = 4_000_000,
  maxEdits = FAR_EDITS,
  maxSteps = FAR_STEPS,
): DiffLine[] | null {
  const near = diffLines(a, b, maxCells);
  if (near) return near;
  const x = a.split('\n');
  const y = b.split('\n');
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  // Each distinct line as a number, so that a comparison is of two integers.
  const ids = new Map<string, number>();
  const id = (line: string) => {
    let n = ids.get(line);
    if (n === undefined) ids.set(line, (n = ids.size));
    return n;
  };
  const p = Int32Array.from(x.slice(start, endX), id);
  const q = Int32Array.from(y.slice(start, endY), id);
  const n = p.length;
  const m = q.length;
  const most = Math.min(maxEdits, n + m);
  // far[k + most]: how far along p the path on diagonal k (lines of p less lines of q) has got.
  const far = new Int32Array(2 * most + 2);
  // seen[d]: `far` for diagonals -d..d as it was before the round of d edits.
  const seen: Int32Array[] = [];
  let steps = 0;
  let edits = -1;
  for (let d = 0; d <= most && edits < 0; d++) {
    seen.push(far.slice(most - d, most + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && far[most + k - 1] < far[most + k + 1]);
      let i = down ? far[most + k + 1] : far[most + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && p[i] === q[j]) {
        i++;
        j++;
        steps++;
      }
      far[most + k] = i;
      if (i >= n && j >= m) {
        edits = d;
        break;
      }
    }
    steps += d + 1;
    if (edits < 0 && steps > maxSteps) return null;
  }
  if (edits < 0) return null;
  // Back from the end: which edit each round made, last first.
  const back: DiffLine[] = [];
  let i = n;
  let j = m;
  for (let d = edits; d > 0; d--) {
    const v = seen[d];
    const at = (k: number) => v[k + d];
    const k = i - j;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const fromI = down ? at(k + 1) : at(k - 1);
    const fromJ = fromI - (down ? k + 1 : k - 1);
    while (i > fromI + (down ? 0 : 1) && j > fromJ + (down ? 1 : 0)) {
      back.push({ op: ' ', text: x[start + --i] });
      j--;
    }
    if (down) back.push({ op: '+', text: y[start + --j] });
    else back.push({ op: '-', text: x[start + --i] });
  }
  while (i > 0) {
    back.push({ op: ' ', text: x[start + --i] });
    j--;
  }
  const out: DiffLine[] = x.slice(0, start).map((text) => ({ op: ' ', text }));
  // Within a run of changed lines the removals come first, as `diffLines` gives them.
  let added: DiffLine[] = [];
  for (let r = back.length - 1; r >= 0; r--) {
    const line = back[r];
    if (line.op === '+') {
      added.push(line);
      continue;
    }
    if (line.op === ' ' && added.length) {
      out.push(...added);
      added = [];
    }
    out.push(line);
  }
  out.push(...added);
  for (const text of x.slice(endX)) out.push({ op: ' ', text });
  return out;
}

export type WordPiece = { changed: boolean; text: string };

const WORDS = /\\?[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*|\s+|[^]/gu;

/**
 * `a` and `b` as pieces, each marked changed or not, so that the pieces of `was` join to `a` and
 * those of `now` to `b`. A word (with its `\command`, `0.05` or `thirty-five` kept whole), a run of
 * white space or any other character is compared as one. Kept white space between two changes is
 * marked changed too, so one changed phrase is one piece. Returns null if the texts are too large
 * to compare here.
 */
export function diffWords(
  a: string,
  b: string,
  maxCells = 1_000_000,
): { was: WordPiece[]; now: WordPiece[] } | null {
  const ops = diffSeq(a.match(WORDS) ?? [], b.match(WORDS) ?? [], maxCells);
  if (!ops) return null;
  const was: WordPiece[] = [];
  const now: WordPiece[] = [];
  const add = (to: WordPiece[], changed: boolean, text: string) => {
    const last = to.at(-1);
    if (last?.changed === changed) last.text += text;
    else to.push({ changed, text });
  };
  ops.forEach(({ op, text }, k) => {
    const prev = ops[k - 1]?.op;
    const next = ops[k + 1]?.op;
    const changed = op === ' ' && !text.trim() && !!prev && !!next && prev !== ' ' && next !== ' ';
    if (op !== '+') add(was, op === '-' || changed, text);
    if (op !== '-') add(now, op === '+' || changed, text);
  });
  return { was, now };
}

/** A line of a diff; a removed or added one paired with its counterpart has its text in pieces. */
export type DiffRow = DiffLine & { words?: WordPiece[] };

export type DiffHunk = {
  /** Unchanged lines left out just before this hunk. */
  skipped: number;
  /** The line of the newer text the hunk's first row is at (a removed first row: the line the next newer line has). From 1. */
  line: number;
  rows: DiffRow[];
};

/** At most this many pairs of lines are compared word by word in one call (the cheap check is free). */
const MAX_COMPARISONS = 400;

/** A run of changed rows with more cells than this (removed x added) pairs by position only. */
const MAX_RUN_CELLS = 100;

type Counterpart = { was: WordPiece[]; now: WordPiece[]; kept: number };

/** The words of `a` and `b` marked, and how many characters they share, if the lines are plain counterparts. */
function counterpart(a: string, b: string, budget: { left: number }): Counterpart | null {
  const ta = a.trim();
  const tb = b.trim();
  if (!ta || !tb) return null;
  // Cheap check before the table: the words the two lines share, counted as a multiset.
  const count = new Map<string, number>();
  let na = 0;
  for (const t of ta.match(WORDS) ?? []) {
    if (!t.trim()) continue;
    na++;
    count.set(t, (count.get(t) ?? 0) + 1);
  }
  let nb = 0;
  let shared = 0;
  for (const t of tb.match(WORDS) ?? []) {
    if (!t.trim()) continue;
    nb++;
    const c = count.get(t) ?? 0;
    if (c > 0) {
      shared++;
      count.set(t, c - 1);
    }
  }
  if (shared * 3 < Math.max(na, nb)) return null;
  return compare(a, b, budget);
}

/** The word diff of two lines, if mostly the same words (kept non-space characters x3 cover both). */
function compare(a: string, b: string, budget: { left: number }): Counterpart | null {
  if (budget.left <= 0) return null;
  budget.left--;
  const d = diffWords(a, b, 250_000);
  if (!d) return null;
  const kept = d.was.reduce((n, p) => (p.changed || !p.text.trim() ? n : n + p.text.length), 0);
  if (kept * 3 < a.trim().length || kept * 3 < b.trim().length) return null;
  return { was: d.was, now: d.now, kept };
}

/**
 * Matches removed lines to added ones, in order and without crossing, so as to keep the most
 * shared characters. Small runs are matched by likeness; a run over MAX_RUN_CELLS cells is paired
 * by position, only when it has as many removed lines as added ones.
 */
function pairRun(gone: DiffRow[], added: DiffRow[], budget: { left: number }) {
  const n = gone.length;
  const m = added.length;
  const set = (g: DiffRow, a: DiffRow, c: Counterpart) => {
    g.words = c.was;
    a.words = c.now;
  };
  if (n * m > MAX_RUN_CELLS) {
    if (n !== m) return;
    for (let k = 0; k < n; k++) {
      const c = compare(gone[k].text, added[k].text, budget);
      if (c) set(gone[k], added[k], c);
    }
    return;
  }
  const found: (Counterpart | null)[][] = [];
  for (let i = 0; i < n; i++) {
    found.push([]);
    for (let j = 0; j < m; j++) {
      found[i].push(counterpart(gone[i].text, added[j].text, budget));
    }
  }
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const c = found[i][j];
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], c ? c.kept + best[i + 1][j + 1] : 0);
    }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const c = found[i][j];
    if (c && best[i][j] === c.kept + best[i + 1][j + 1]) {
      set(gone[i++], added[j++], c);
    } else if (best[i][j] === best[i + 1][j]) i++;
    else j++;
  }
}

/**
 * Only the changed lines of `lines` (from `diffLines`) and `context` kept lines around each, in
 * hunks, with how many unchanged lines were left out before each hunk and after the last. A
 * removed line and an added line that are plain counterparts (mostly the same words, matched in
 * order within a run of changed rows) carry their words, marked changed or not. sum(skipped) + all rows + rest
 * is `lines.length`.
 */
export function diffHunks(lines: DiffLine[], context = 3): { hunks: DiffHunk[]; rest: number } {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++)
      keep[k] = true;
  });
  const hunks: DiffHunk[] = [];
  let newer = 0; // lines of the newer text before index i
  let last = 0; // index after the previous hunk
  const budget = { left: MAX_COMPARISONS };
  let i = 0;
  while (i < lines.length) {
    if (!keep[i]) {
      if (lines[i].op !== '-') newer++;
      i++;
      continue;
    }
    const start = i;
    const hunk: DiffHunk = { skipped: start - last, line: newer + 1, rows: [] };
    while (i < lines.length && keep[i]) {
      hunk.rows.push({ ...lines[i] });
      if (lines[i].op !== '-') newer++;
      i++;
    }
    last = i;
    // Pair the removed and added lines of each run of changed rows.
    const rows = hunk.rows;
    for (let r = 0; r < rows.length;) {
      if (rows[r].op === ' ') {
        r++;
        continue;
      }
      const run: DiffRow[] = [];
      while (r < rows.length && rows[r].op !== ' ') run.push(rows[r++]);
      const gone = run.filter((x) => x.op === '-');
      const added = run.filter((x) => x.op === '+');
      pairRun(gone, added, budget);
    }
    hunks.push(hunk);
  }
  return { hunks, rest: lines.length - last };
}

/**
 * Where a line of one text is in the other, over `diffLines`' result of (built text, text now).
 * A kept line maps exactly. A line that was removed (asking `toNow`) or added (asking `toBuilt`)
 * has no counterpart: it maps to the nearest kept line after it, else before it, and `moved` says
 * so. Lines are counted from 1. With no diff (the texts were too large to compare) the line is
 * kept as it is, and `moved`.
 */
export function carryLine(
  diff: DiffLine[] | null,
  line: number,
  direction: 'toNow' | 'toBuilt',
): { line: number; moved: boolean } {
  if (!diff) return { line, moved: true };
  // The ops that are in the text asked from, and the one it is mapped to.
  const gone = direction === 'toNow' ? '-' : '+';
  const other = direction === 'toNow' ? '+' : '-';
  let from = 0;
  let to = 0;
  let at = -1;
  const kept: { index: number; to: number }[] = [];
  for (let i = 0; i < diff.length; i++) {
    const op = diff[i].op;
    if (op !== other) from++;
    if (op !== gone) to++;
    if (op === ' ') kept.push({ index: i, to });
    if (op !== other && from === line) at = i;
  }
  if (at >= 0 && diff[at].op === ' ')
    return { line: kept.find((k) => k.index === at)!.to, moved: false };
  const after = at < 0 ? undefined : kept.find((k) => k.index > at);
  const before = kept.findLast((k) => k.index < at || at < 0);
  const near = after ?? before;
  // Nothing was kept, or the line is past the end of the text: the nearest line that is there.
  return { line: near ? near.to : Math.max(1, Math.min(line, to)), moved: true };
}
