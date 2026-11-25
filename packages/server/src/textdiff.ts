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

/** One run of the base replaced by `repl`: base items `start` up to `end` become `repl`. */
type Hunk = { start: number; end: number; repl: string[] };

/** The changed runs of a diff of x to y, in order, each added item mapped through `item`. */
function hunksOf(ops: DiffLine[], item: (text: string) => string): Hunk[] {
  const out: Hunk[] = [];
  let at = 0;
  let cur: Hunk | null = null;
  for (const { op, text } of ops) {
    if (op === ' ') {
      cur = null;
      at++;
      continue;
    }
    if (!cur) out.push((cur = { start: at, end: at, repl: [] }));
    if (op === '-') cur.end = ++at;
    else cur.repl.push(item(text));
  }
  return out;
}

/** What one stretch of the three texts is: base, ours and theirs, and whether the sides clash. */
type Piece = { base: string[]; ours: string[]; theirs: string[]; clash: boolean };

const same = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * The diff3 walk over a base and the changed runs of two sides. Runs of the two sides that overlap
 * or start at the same place are one stretch (a change that only starts where another ends is not); a stretch changed by one side only, or changed the same way by both,
 * is settled; any other is a clash.
 */
function walk(base: string[], ho: Hunk[], ht: Hunk[]): Piece[] {
  const out: Piece[] = [];
  const apply = (hs: Hunk[], from: number, to: number, lo: number, hi: number) => {
    let r: string[] = [];
    let at = lo;
    for (let k = from; k < to; k++) {
      r = r.concat(base.slice(at, hs[k].start), hs[k].repl);
      at = hs[k].end;
    }
    return r.concat(base.slice(at, hi));
  };
  let pos = 0;
  let i = 0;
  let j = 0;
  while (i < ho.length || j < ht.length) {
    const lo = Math.min(ho[i]?.start ?? Infinity, ht[j]?.start ?? Infinity);
    let hi = lo;
    const i0 = i;
    const j0 = j;
    for (let grew = true; grew;) {
      grew = false;
      if (i < ho.length && (ho[i].start < hi || ho[i].start === lo)) {
        hi = Math.max(hi, ho[i++].end);
        grew = true;
      }
      if (j < ht.length && (ht[j].start < hi || ht[j].start === lo)) {
        hi = Math.max(hi, ht[j++].end);
        grew = true;
      }
    }
    if (lo > pos) {
      const kept = base.slice(pos, lo);
      out.push({ base: kept, ours: kept, theirs: kept, clash: false });
    }
    const ours = apply(ho, i0, i, lo, hi);
    const theirs = apply(ht, j0, j, lo, hi);
    out.push({
      base: base.slice(lo, hi),
      ours,
      theirs,
      clash: i > i0 && j > j0 && !same(ours, theirs),
    });
    pos = hi;
  }
  if (pos < base.length) {
    const kept = base.slice(pos);
    out.push({ base: kept, ours: kept, theirs: kept, clash: false });
  }
  return out;
}

export type MergeConflict = {
  /**
   * `both-changed`: both sides changed the same words differently. `deleted-vs-changed`: one side
   * removed the stretch and the other changed it. `both-added`: both added different text at one
   * place. `too-large`: the texts were too large or too changed to compare; the whole text is the
   * conflict.
   */
  kind: 'both-changed' | 'deleted-vs-changed' | 'both-added' | 'too-large';
  base: string;
  ours: string;
  theirs: string;
  /** Where each version of the stretch sits in its own text: `[start, end)` in characters. */
  baseStart: number;
  baseEnd: number;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
  /** Where `ours` sits in the merged `text` (which holds ours at every conflict). */
  textStart: number;
  /** The line of the base the stretch starts on, from 1. */
  line: number;
};

export type MergeChoice = 'ours' | 'theirs' | 'both' | 'base' | { text: string };

export type MergeResult = {
  /** The merge with `ours` kept at every conflict. With no conflicts, the merge. */
  text: string;
  conflicts: MergeConflict[];
  /** The merge in order: settled text, and each conflict where it sits. With ours chosen they join to `text`. */
  chunks: (string | MergeConflict)[];
};

/** Lines with the newline each ends in; the last has none if the text does not end in one. */
const lineParts = (text: string) => text.match(/[^\n]*\n|[^\n]+/g) ?? [];

function conflictOf(
  kind: MergeConflict['kind'] | null,
  base: string,
  ours: string,
  theirs: string,
  at: number[],
  textStart: number,
  whole = '',
): MergeConflict {
  return {
    kind:
      kind ??
      (base === ''
        ? 'both-added'
        : ours === '' || theirs === ''
          ? 'deleted-vs-changed'
          : 'both-changed'),
    base,
    ours,
    theirs,
    baseStart: at[0],
    baseEnd: at[0] + base.length,
    oursStart: at[1],
    oursEnd: at[1] + ours.length,
    theirsStart: at[2],
    theirsEnd: at[2] + theirs.length,
    textStart,
    line: whole.slice(0, at[0]).split('\n').length,
  };
}

/**
 * Merges two edits of one text: `ours` and `theirs` are each a change of `base`.
 *
 * Lines are compared first. A run of lines changed by one side is taken; one changed the same way
 * by both is taken once. Where both changed the same lines, the stretch is merged
 * again by words (the pieces `diffWords` compares), because a paragraph is often one long line:
 * words changed by one side are taken, and only words changed differently by both, or removed by
 * one and changed by the other, are a conflict. Two neighbouring lines each edited in different
 * words merge without a conflict. Bytes outside the changed words are kept exactly, including the
 * kind of newline and whether the text ends in one.
 *
 * The size guard is that of the comparisons: if `base` and either side differ by more than
 * `diffLinesFar` will report (`FAR_EDITS` lines, or its table or step limits) the whole text is
 * one `too-large` conflict with ours in `text`; if the words of one stretch of lines need more
 * than `wordCells` table cells (default 1,000,000, as `diffWords`), that stretch is one conflict.
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  limits: { maxCells?: number; wordCells?: number } = {},
): MergeResult {
  if (ours === theirs || theirs === base) return { text: ours, conflicts: [], chunks: [ours] };
  if (ours === base) return { text: theirs, conflicts: [], chunks: [theirs] };

  const B = lineParts(base);
  const O = lineParts(ours);
  const T = lineParts(theirs);
  // Each distinct line as a number, so that diffLinesFar can compare them. Every encoded line ends
  // in "\n", so all three encodings end alike and the last element of a diff is dropped.
  const ids = new Map<string, number>();
  const lines: string[] = [];
  const encode = (ls: string[]) =>
    ls
      .map((l) => {
        let n = ids.get(l);
        if (n === undefined) {
          ids.set(l, (n = lines.length));
          lines.push(l);
        }
        return `${n}\n`;
      })
      .join('');
  const eb = encode(B);
  const diffO = diffLinesFar(eb, encode(O), limits.maxCells);
  const diffT = diffLinesFar(eb, encode(T), limits.maxCells);
  if (!diffO || !diffT) {
    const c = conflictOf('too-large', base, ours, theirs, [0, 0, 0], 0);
    return { text: ours, conflicts: [c], chunks: [c] };
  }
  const byLine = (id: string) => lines[Number(id)];
  const pieces = walk(B, hunksOf(diffO.slice(0, -1), byLine), hunksOf(diffT.slice(0, -1), byLine));

  // Merge each clashing stretch again by words.
  type Final = { base: string; ours: string; theirs: string; clash: boolean };
  const final: Final[] = [];
  for (const p of pieces) {
    const f: Final = {
      base: p.base.join(''),
      ours: p.ours.join(''),
      theirs: p.theirs.join(''),
      clash: p.clash,
    };
    if (!p.clash) {
      final.push(f);
      continue;
    }
    const wb = f.base.match(WORDS) ?? [];
    const cells = limits.wordCells ?? 1_000_000;
    const dO = diffSeq(wb, f.ours.match(WORDS) ?? [], cells);
    const dT = diffSeq(wb, f.theirs.match(WORDS) ?? [], cells);
    if (!dO || !dT) {
      final.push(f);
      continue;
    }
    for (const w of walk(
      wb,
      hunksOf(dO, (s) => s),
      hunksOf(dT, (s) => s),
    ))
      final.push({
        base: w.base.join(''),
        ours: w.ours.join(''),
        theirs: w.theirs.join(''),
        clash: w.clash,
      });
  }

  const chunks: (string | MergeConflict)[] = [];
  const conflicts: MergeConflict[] = [];
  let text = '';
  const at = [0, 0, 0]; // offsets in base, ours and theirs
  const addText = (s: string) => {
    text += s;
    const last = chunks.length - 1;
    if (typeof chunks[last] === 'string') chunks[last] += s;
    else chunks.push(s);
  };
  for (const f of final) {
    if (f.clash) {
      const c = conflictOf(null, f.base, f.ours, f.theirs, at, text.length, base);
      conflicts.push(c);
      chunks.push(c);
      text += f.ours;
    } else addText(f.ours !== f.base ? f.ours : f.theirs);
    at[0] += f.base.length;
    at[1] += f.ours.length;
    at[2] += f.theirs.length;
  }
  return { text, conflicts, chunks };
}

/**
 * The merged text with each conflict settled by the choice at its index: ours, theirs, both (ours
 * first), the base, or text written by hand. Throws if a conflict has no choice.
 */
export function resolveMerge(result: MergeResult, choices: MergeChoice[]): string {
  let k = 0;
  return result.chunks
    .map((c) => {
      if (typeof c === 'string') return c;
      const choice = choices[k++];
      if (!choice) throw new Error(`No choice for conflict ${k}.`);
      if (typeof choice === 'object') return choice.text;
      return choice === 'both' ? c.ours + c.theirs : c[choice];
    })
    .join('');
}
