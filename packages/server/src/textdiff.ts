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
