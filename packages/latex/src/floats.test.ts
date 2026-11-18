import { expect, test } from 'vitest';
import { altEdit, cellText, floatParts, tableEdit, type TableOp } from './floats.ts';
import { fixtureFiles } from './testutil.ts';

const text = (path: string) => Buffer.from(fixtureFiles()[path]).toString();
/** Every span must say exactly what is at its place in the source. */
const honest = (src: string, spans: ({ text: string; at: number; end: number } | null)[]) => {
  for (const s of spans) if (s) expect(src.slice(s.at, s.end)).toBe(s.text);
};

test('a table from a fixture is read as rows of cells, rules left out', () => {
  const src = text('ieee-multifile/tables/ablation.tex').trimEnd();
  const float = floatParts(src)!;
  expect(float.kind).toBe('table');
  expect(float.caption?.text).toBe('Edits checked per template');
  expect(float.table!.simple).toBe(true);
  expect(float.table!.rows.map((r) => r.map((c) => c.text))).toEqual([
    ['Template', 'Edits', 'Out-of-range bytes'],
    ['article', '4000', '0'],
    ['IEEEtran', '3000', '0'],
    ['amsart', '3000', '0'],
  ]);
  honest(src, [float.caption, ...float.table!.rows.flat()]);
});

test('cells keep their LaTeX, and what a grid cannot show is said to be not simple', () => {
  const src = [
    '\\begin{table*}',
    '\\begin{tabular}{l@{ }r|p{2cm}} \\hline',
    '  A \\& B & $x & y$ is not maths here & {a & b} \\\\[2pt] % a comment & with an ampersand',
    '  \\cmidrule(lr){1-2}  & \\textbf{bold} &   \\\\*',
    '  100\\% & \\num{3} & last',
    '\\end{tabular}',
    '\\caption[Short]{A caption with \\emph{markup} and {braces}.}',
    '\\end{table*}',
  ].join('\n');
  const float = floatParts(src)!;
  expect(float.caption?.text).toBe('A caption with \\emph{markup} and {braces}.');
  expect(float.table!.rows.map((r) => r.map((c) => c.text))).toEqual([
    ['A \\& B', '$x', 'y$ is not maths here', '{a & b}'],
    ['', '\\textbf{bold}', ''],
    ['100\\%', '\\num{3}', 'last'],
  ]);
  // Rows of different lengths: not a plain grid.
  expect(float.table!.simple).toBe(false);
  honest(src, [float.caption, ...float.table!.rows.flat()]);
  // An empty cell still has a place: where its text would go.
  const empty = float.table!.rows[1][0];
  expect(empty.at).toBe(empty.end);

  for (const hard of ['\\multicolumn{2}{c}{Wide} & x', '\\multirow{2}{*}{Tall} & x & y'])
    expect(
      floatParts(
        `\\begin{table}\\begin{tabular}{lll}a & b & c \\\\ ${hard} \\\\\\end{tabular}\\end{table}`,
      )!.table!.simple,
    ).toBe(false);
  expect(
    floatParts(
      '\\begin{table}\\begin{tabularx}{\\linewidth}{lX} a & b \\\\ c & d \\end{tabularx}\\end{table}',
    )!.table,
  ).toMatchObject({
    simple: true,
    rows: [
      [{ text: 'a' }, { text: 'b' }],
      [{ text: 'c' }, { text: 'd' }],
    ],
  });
  expect(floatParts('\\begin{table}no grid here\\end{table}')!.table).toBeNull();
  expect(floatParts('\\begin{center}x\\end{center}')).toBeNull();
});

test('a picture is found with its file and its description', () => {
  const src = [
    '\\begin{figure}[t]',
    '  \\includegraphics[width=\\linewidth, alt={Latency rises with writers}]{figures/latency}',
    '  \\includegraphics[alt=short text,scale=2]{b.png} \\includegraphics{c} \\includegraphics[width=2cm]{d}',
    '  % \\includegraphics{commented}',
    '  \\caption{Two pictures.}',
    '\\end{figure}',
  ].join('\n');
  const float = floatParts(src)!;
  expect(float.kind).toBe('figure');
  expect(float.graphics.map((g) => [g.target.text, g.alt?.text ?? null])).toEqual([
    ['figures/latency', 'Latency rises with writers'],
    ['b.png', 'short text'],
    ['c', null],
    ['d', null],
  ]);
  honest(
    src,
    float.graphics.flatMap((g) => [g.target, g.alt]),
  );
  expect(float.table).toBeNull();

  // Giving or changing a description touches the description and nothing else.
  const apply = (e: { at: number; length: number; insert: string }) =>
    src.slice(0, e.at) + e.insert + src.slice(e.at + e.length);
  expect(apply(altEdit(float.graphics[0], '  A new\n description ')!)).toBe(
    src.replace('Latency rises with writers', 'A new description'),
  );
  expect(apply(altEdit(float.graphics[2], 'Third')!)).toBe(
    src.replace('\\includegraphics{c}', '\\includegraphics[alt={Third}]{c}'),
  );
  expect(apply(altEdit(float.graphics[3], 'Fourth')!)).toBe(
    src.replace('[width=2cm]{d}', '[width=2cm,alt={Fourth}]{d}'),
  );
  // What LaTeX would read as something else cannot be written into an option.
  for (const bad of ['50% faster', 'a {brace}', 'back\\slash', 'hash #1', 'a ] bracket'])
    expect(altEdit(float.graphics[2], bad)).toBeNull();
});

test('text that would break the grid is not accepted as a cell', () => {
  for (const good of ['plain', '100\\%', 'A \\& B', '\\textbf{bold}', '$x^2$', '{a & b}', ''])
    expect(cellText(good), good).toBe(true);
  for (const bad of ['a & b', 'a \\\\ b', 'two\nlines', 'open {brace', 'close} brace', 'a % b'])
    expect(cellText(bad), bad).toBe(false);
});

test('rows and columns are added and removed, and adding then removing restores every byte', () => {
  const src = text('ieee-multifile/tables/ablation.tex').trimEnd();
  const apply = (from: string, op: TableOp) => {
    const e = tableEdit(from, floatParts(from)!.table!, op)!;
    expect(e, JSON.stringify(op)).not.toBeNull();
    return from.slice(0, e.at) + e.insert + from.slice(e.at + e.length);
  };
  const grid = (from: string) => floatParts(from)!.table!.rows.map((r) => r.map((c) => c.text));

  // A row after the second: empty cells, indented like its neighbours, rules untouched.
  const taller = apply(src, { kind: 'row-after', row: 1 });
  expect(taller).toBe(
    src.replace('    article & 4000 & 0 \\\\\n', '    article & 4000 & 0 \\\\\n     &  &  \\\\\n'),
  );
  expect(grid(taller)[2]).toEqual(['', '', '']);
  expect(floatParts(taller)!.table!.simple).toBe(true);
  expect(apply(taller, { kind: 'row-delete', row: 2 })).toBe(src);
  // Removing a row takes its line and leaves the rule above it.
  expect(apply(src, { kind: 'row-delete', row: 1 })).toBe(
    src.replace('    article & 4000 & 0 \\\\\n', ''),
  );

  // A column after the first: every row gains a cell, and the specification a letter.
  const wider = apply(src, { kind: 'column-after', column: 0 });
  expect(wider).toContain('\\begin{tabular}{@{}llrr@{}}');
  expect(grid(wider)).toEqual([
    ['Template', '', 'Edits', 'Out-of-range bytes'],
    ['article', '', '4000', '0'],
    ['IEEEtran', '', '3000', '0'],
    ['amsart', '', '3000', '0'],
  ]);
  expect(apply(wider, { kind: 'column-delete', column: 1 })).toBe(src);
  // Removing the first, a middle and the last column.
  expect(grid(apply(src, { kind: 'column-delete', column: 0 }))[1]).toEqual(['4000', '0']);
  expect(apply(src, { kind: 'column-delete', column: 0 })).toContain('{@{}rr@{}}');
  expect(grid(apply(src, { kind: 'column-delete', column: 1 }))[1]).toEqual(['article', '0']);
  expect(apply(src, { kind: 'column-delete', column: 2 })).toContain('    article & 4000 \\\\');
  // Everything outside the table's own lines is as it was.
  for (const changed of [taller, wider])
    expect(changed.slice(0, changed.indexOf('\\begin{tabular}'))).toBe(
      src.slice(0, src.indexOf('\\begin{tabular}')),
    );

  // A last row with no \\ of its own, and a table of one row or one column.
  const bare =
    '\\begin{table}\\begin{tabular}{l|p{2cm}}\n  a & b \\\\\n  c & d\n\\end{tabular}\\end{table}';
  const grown = apply(bare, { kind: 'row-after', row: 1 });
  expect(grown).toContain('  c & d \\\\\n   & \n\\end{tabular}');
  expect(grid(grown)).toEqual([
    ['a', 'b'],
    ['c', 'd'],
    ['', ''],
  ]);
  expect(apply(bare, { kind: 'column-delete', column: 1 })).toContain('{l|}');
  const one = floatParts(
    '\\begin{table}\\begin{tabular}{l} only \\\\ \\end{tabular}\\end{table}',
  )!.table!;
  expect(tableEdit('', one, { kind: 'row-delete', row: 0 })).toBeNull();
  expect(tableEdit('', one, { kind: 'column-delete', column: 0 })).toBeNull();
  // A specification this does not take apart: rows can still change, columns cannot.
  const starred =
    '\\begin{table}\\begin{tabular}{*{2}{c}} a & b \\\\ c & d \\\\ \\end{tabular}\\end{table}';
  expect(
    tableEdit(starred, floatParts(starred)!.table!, { kind: 'column-after', column: 0 }),
  ).toBeNull();
  expect(
    tableEdit(starred, floatParts(starred)!.table!, { kind: 'row-after', row: 0 }),
  ).not.toBeNull();
});
