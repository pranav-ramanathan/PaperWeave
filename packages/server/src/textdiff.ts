// A line diff for showing what changed between two revisions of a file.

export type DiffLine = { op: ' ' | '+' | '-'; text: string };

/**
 * The lines of `a` and `b` as kept, removed and added, in order. Returns null if the files are too
 * large to compare line by line here.
 * shortcut: a plain longest-common-subsequence table, quadratic in the changed region. Fine for
 * papers; switch to Myers' algorithm if files of tens of thousands of changed lines turn up.
 */
export function diffLines(a: string, b: string, maxCells = 4_000_000): DiffLine[] | null {
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
