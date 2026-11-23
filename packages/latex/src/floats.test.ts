import { expect, test } from 'vitest';
import {
  altEdit,
  captionText,
  cellText,
  fieldText,
  floatParts,
  tableEdit,
  type TableOp,
} from './floats.ts';
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

test('a lone trailing backslash is not accepted in a cell', () => {
  for (const bad of ['ends \\', 'a \\\\\\']) expect(cellText(bad), bad).toBe(false);
  for (const good of ['A \\& B', '100\\%']) expect(cellText(good), good).toBe(true);
});

test('text that would break a caption is not accepted', () => {
  for (const good of [
    'plain',
    '95\\%',
    'A \\& B',
    'Title \\\\ subtitle',
    '\\textbf{x}',
    '$a_1$',
    '{a & b}',
    '',
    'a \\\\',
  ])
    expect(captionText(good), good).toBe(true);
  for (const bad of [
    '95% of runs',
    'open {brace',
    'close} brace',
    'a & b',
    'two\nlines',
    'ends \\',
    'ends \\\\\\',
  ])
    expect(captionText(bad), bad).toBe(false);
});

test('a description written without braces gets them when it needs them', () => {
  const src = '\\begin{figure}\\includegraphics[alt=A dot,width=3cm]{dot.png}\\end{figure}';
  const g = floatParts(src)!.graphics[0];
  expect(g.altBare).toBe(true);
  const apply = (from: string, e: { at: number; length: number; insert: string }) =>
    from.slice(0, e.at) + e.insert + from.slice(e.at + e.length);
  for (const [typed, written] of [
    ['Red, green and blue', 'alt={Red, green and blue}'],
    ['a = b', 'alt={a = b}'],
    ['A square', 'alt=A square'],
  ]) {
    const out = apply(src, altEdit(g, typed)!);
    expect(out, typed).toBe(src.replace('alt=A dot', written));
    expect(floatParts(out)!.graphics[0].alt?.text, typed).toBe(typed);
  }
  const braced = '\\begin{figure}\\includegraphics[alt={A, dot}]{dot.png}\\end{figure}';
  const b = floatParts(braced)!.graphics[0];
  expect(b.altBare).toBe(false);
  expect(apply(braced, altEdit(b, 'x, y')!)).toBe(braced.replace('A, dot', 'x, y'));
  const none = floatParts('\\begin{figure}\\includegraphics{dot.png}\\end{figure}')!.graphics[0];
  expect(none.altBare).toBe(false);
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

/** The table of a tabular body, as rows of cell text. */
const tab = (body: string) =>
  `\\begin{table}\n\\begin{tabular}{lr}\n${body}\n\\end{tabular}\n\\end{table}`;
const rowsOf = (src: string) => floatParts(src)!.table!.rows.map((r) => r.map((c) => c.text));
const editBy = (from: string, op: TableOp) => {
  const e = tableEdit(from, floatParts(from)!.table!, op)!;
  expect(e, JSON.stringify(op)).not.toBeNull();
  return from.slice(0, e.at) + e.insert + from.slice(e.at + e.length);
};

test('a commented-out row is not part of the rows around it', () => {
  const src = tab('Name & Value \\\\\na & 1 \\\\\n% c & 3 \\\\\nb & 2 \\\\');
  const t = floatParts(src)!.table!;
  expect(rowsOf(src)).toEqual([
    ['Name', 'Value'],
    ['a', '1'],
    ['b', '2'],
  ]);
  expect(t.simple).toBe(true);
  honest(src, t.rows.flat());
  // Deleting a column leaves the comment alone.
  expect(editBy(src, { kind: 'column-delete', column: 0 }).split('\n')).toContain('% c & 3 \\\\');
  // Deleting the row after the comment takes that row and no more.
  expect(editBy(src, { kind: 'row-delete', row: 2 })).toBe(src.replace('\nb & 2 \\\\', ''));
});

test('a commented-out last row is not a row', () => {
  const src = tab('Name & Value \\\\\na & 1 \\\\\n% b & 2 \\\\');
  expect(rowsOf(src)).toEqual([
    ['Name', 'Value'],
    ['a', '1'],
  ]);
  expect(floatParts(src)!.table!.simple).toBe(true);
});

test('a comment right after the end of a row stays with that row', () => {
  const src = tab('Name & Value \\\\% note\nb & 2 \\\\');
  expect(rowsOf(src)).toEqual([
    ['Name', 'Value'],
    ['b', '2'],
  ]);
  const src2 = tab('Name & Value \\\\ % header\na & 1 \\\\');
  expect(rowsOf(src2)).toEqual([
    ['Name', 'Value'],
    ['a', '1'],
  ]);
  const taller = editBy(src2, { kind: 'row-after', row: 0 });
  expect(taller).toBe(tab('Name & Value \\\\ % header\n     &  \\\\\na & 1 \\\\'));
  expect(editBy(taller, { kind: 'row-delete', row: 1 })).toBe(src2);
});

test('a comment at the end of a cell is not its text, and a new column goes before it', () => {
  const src = tab('Name & Value \\\\\na & 1 % was 2\n\\\\');
  expect(rowsOf(src)).toEqual([
    ['Name', 'Value'],
    ['a', '1'],
  ]);
  const wider = editBy(src, { kind: 'column-after', column: 1 });
  const t = floatParts(wider)!.table!;
  expect(t.simple).toBe(true);
  expect(t.rows.map((r) => r.length)).toEqual([3, 3]);
});

test('a comment in the middle of a cell makes the table not simple', () => {
  expect(floatParts(tab('a % note\n& 1 more % x\n words \\\\'))!.table!.simple).toBe(false);
});

test('rules before a comment leave the comment out of the next row', () => {
  const src = tab('Name & Value \\\\ \\hline % c\na & 1 \\\\\nb & 2 \\\\');
  expect(rowsOf(src)).toEqual([
    ['Name', 'Value'],
    ['a', '1'],
    ['b', '2'],
  ]);
  expect(editBy(src, { kind: 'row-delete', row: 1 })).toBe(
    tab('Name & Value \\\\ \\hline % c\nb & 2 \\\\'),
  );
  // A comment line straight after the specification survives deleting the first row.
  const top = tab('% top\na & 1 \\\\\nb & 2 \\\\');
  expect(editBy(top, { kind: 'row-delete', row: 0 })).toBe(tab('% top\nb & 2 \\\\'));
  // An empty first cell after a comment line is placed after the comment, not inside it.
  const gap = tab('% top\n & 1 \\\\\nb & 2 \\\\');
  const first = floatParts(gap)!.table!.rows[0][0];
  expect(first.at).toBeGreaterThan(gap.indexOf('% top\n'));
  expect(gap.slice(first.at - 1, first.at)).toBe(' ');
  expect(rowsOf(tab('50\\% & 1 \\\\'))).toEqual([['50\\%', '1']]);
});

test('a part is shown as one line if that loses nothing', () => {
  expect(fieldText('Scores on the\nbenchmark.')).toBe('Scores on the benchmark.');
  expect(fieldText('%\n  Text')).toBe('Text');
  expect(fieldText('a%\n b')).toBe('ab');
  expect(fieldText(' x ')).toBe('x');
  expect(fieldText('50\\% of')).toBe('50\\% of');
  expect(fieldText('a % note\nb')).toBeNull();
  expect(fieldText('a\n\nb')).toBeNull();
});

/** A table of one column: the text between \begin{tabular}{l} and \end{tabular}. */
const one = (body: string) =>
  `\\begin{table}\n\\begin{tabular}{l}\n${body}\n\\end{tabular}\n\\end{table}`;
const column = (src: string) => rowsOf(src).map((r) => r.map((c) => c.trim()));

test('a row added to a one-column table is a row: at the end, in the middle, at the start', () => {
  for (const tail of [' \\\\', '']) {
    const src = one(`  a \\\\\n  b \\\\\n  c${tail}`);
    expect(column(src)).toEqual([['a'], ['b'], ['c']]);
    // After the last row (with or without a \\ of its own), and again.
    const end = editBy(src, { kind: 'row-after', row: 2 });
    expect(column(end), tail).toEqual([['a'], ['b'], ['c'], ['']]);
    const end2 = editBy(end, { kind: 'row-after', row: 3 });
    expect(column(end2), tail).toEqual([['a'], ['b'], ['c'], [''], ['']]);
    // In the middle.
    const mid = editBy(src, { kind: 'row-after', row: 0 });
    expect(column(mid), tail).toEqual([['a'], [''], ['b'], ['c']]);
    // And a row can be taken away again, to the byte.
    expect(editBy(mid, { kind: 'row-delete', row: 1 })).toBe(src);
    // (A last row given a \\ to make room for the new one keeps it.)
    expect(editBy(end, { kind: 'row-delete', row: 3 })).toBe(
      tail ? src : src.replace('  c\n', '  c \\\\\n'),
    );
    // The new row's cell is edited alone.
    for (const [made, at, rows] of [
      [end, 3, ['a', 'b', 'c', 'X']],
      [mid, 1, ['a', 'X', 'b', 'c']],
    ] as const) {
      const cell = floatParts(made)!.table!.rows[at][0];
      const edited = made.slice(0, cell.at) + 'X' + made.slice(cell.end);
      expect(column(edited)).toEqual(rows.map((t) => [t]));
      expect(edited).toBe(made.slice(0, cell.at) + 'X' + made.slice(cell.at));
    }
  }
});

test('an empty first row of a one-column table is a row', () => {
  // There is no "above" operation; an empty first row, made by hand, reads and takes a row after it.
  const src = one('  \\\\\n  a \\\\');
  expect(column(src)).toEqual([[''], ['a']]);
  expect(column(editBy(src, { kind: 'row-after', row: 0 }))).toEqual([[''], [''], ['a']]);
});

test('a final \\\\ and rules after it do not make a row', () => {
  expect(column(one('  a \\\\\n  b \\\\'))).toEqual([['a'], ['b']]);
  expect(column(one('  \\hline\n  a \\\\ \\hline\n  b \\\\ \\hline'))).toEqual([['a'], ['b']]);
  expect(column(one('  a \\\\ \\hline\n  b \\\\ % end'))).toEqual([['a'], ['b']]);
  expect(rowsOf(tab('a & 1 \\\\ \\hline\nb & 2 \\\\ \\hline'))).toEqual([
    ['a', '1'],
    ['b', '2'],
  ]);
  expect(rowsOf(tab('a & 1 \\\\\nb & 2 \\\\'))).toHaveLength(2);
});

test('rows added to a multi-column table are read as before', () => {
  const src = tab('a & 1 \\\\\nb & 2 \\\\');
  const taller = editBy(src, { kind: 'row-after', row: 1 });
  expect(rowsOf(taller).map((r) => r.map((c) => c.trim()))).toEqual([
    ['a', '1'],
    ['b', '2'],
    ['', ''],
  ]);
});
