import { expect, test } from 'vitest';
import { parseSyncTeX, toPdf, toSource } from './synctex.ts';

// One page with two lines of text. 65781.76 scaled points are one PDF point, so the numbers
// below are easy to read: the first line's baseline is 100 points down, the second's 112.
const pt = (n: number) => Math.round(n * 65781.76);
const at = (x: number, y: number) => `${pt(x)},${pt(y)}`;
const FILE = [
  'SyncTeX Version:1',
  'Input:1:/work/./main.tex',
  'Input:2:/usr/share/texlive/texmf-dist/tex/latex/base/article.cls',
  'Input:3:/work/./sections/a.tex',
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'X Offset:0',
  'Y Offset:0',
  'Content:',
  '!100',
  '{1',
  `[1,9:${at(72, 700)}:${pt(300)},${pt(650)},0`,
  // A line of the paragraph: its box is tagged with the line the paragraph ended on.
  `(1,6:${at(72, 100)}:${pt(300)},${pt(8)},${pt(2)}`,
  `g1,4:${at(100, 100)}`,
  `g1,4:${at(140, 100)}`,
  `g1,5:${at(220, 100)}`,
  ')',
  `(1,6:${at(72, 112)}:${pt(300)},${pt(8)},${pt(2)}`,
  `g1,5:${at(110, 112)}`,
  `x3,2:${at(200, 112)}`,
  // Something a class file made is nobody's line.
  `g2,300:${at(250, 112)}`,
  ')',
  ']',
  '}1',
  '{2',
  `(3,7:${at(72, 90)}:${pt(300)},${pt(8)},${pt(2)}`,
  `g3,7:${at(90, 90)}`,
  ')',
  '}2',
  'Postamble:',
  'Count:9',
  '',
].join('\n');

test("a SyncTeX file is read into the paper's own files and places in PDF points", () => {
  const sync = parseSyncTeX(FILE);
  expect(sync.inputs).toEqual(['main.tex', 'sections/a.tex']);
  // Three line boxes and six things inside them; the page's own box and the class file's glue
  // are left out.
  expect(sync.records).toHaveLength(9);
  const first = sync.records[0];
  expect(first).toMatchObject({ page: 1, file: 0, line: 6, box: true });
  expect([first.x, first.y, first.w, first.h, first.d].map(Math.round)).toEqual([
    72, 100, 300, 8, 2,
  ]);
  // An engine that writes DVI first counts from an inch inside the page.
  const dvi = parseSyncTeX(FILE.replace('Output:pdf', 'Output:xdv'));
  expect(Math.round(dvi.records[0].x * 100)).toBe(Math.round((72 + 72.27) * 100));
});

test('a line leads to where its text begins, and a line that made nothing to the next that did', () => {
  const sync = parseSyncTeX(FILE);
  const line4 = toPdf(sync, 'main.tex', 4)!;
  expect(line4).toMatchObject({ page: 1, line: 4 });
  expect([line4.x, line4.y, line4.height].map(Math.round)).toEqual([100, 92, 10]);
  // Line 5 began on the first line of the paragraph and ran on to the second.
  expect(Math.round(toPdf(sync, 'main.tex', 5)!.x)).toBe(220);
  expect(toPdf(sync, 'main.tex', 1)).toMatchObject({ line: 4 });
  // Past the end: the last line that made something. Line 6 only ended the paragraph that was
  // typed on lines 4 and 5.
  expect(toPdf(sync, 'main.tex', 99)).toMatchObject({ line: 5 });
  expect(toPdf(sync, 'sections/a.tex', 7)).toMatchObject({ page: 2, line: 7 });
  expect(toPdf(sync, 'nope.tex', 1)).toBeNull();
});

test('a point leads to the line that made what is nearest on that line of text', () => {
  const sync = parseSyncTeX(FILE);
  const where = (page: number, x: number, y: number) => {
    const found = toSource(sync, page, x, y);
    return found && `${found.path}:${found.line}`;
  };
  expect(where(1, 105, 97)).toBe('main.tex:4');
  expect(where(1, 230, 97)).toBe('main.tex:5');
  // The second line of text, not the first, though both are close.
  expect(where(1, 115, 108)).toBe('main.tex:5');
  // Another file's text within the same line.
  expect(where(1, 205, 110)).toBe('sections/a.tex:2');
  // Never a class file's line: the nearest of the paper's own.
  expect(where(1, 252, 110)).toBe('sections/a.tex:2');
  // Just outside a line of text, in the margin: the nearest thing on the page.
  expect(where(1, 70, 97)).toBe('main.tex:4');
  // Further than that from anything, the PDF does not say.
  expect(where(1, 20, 300)).toBeNull();
  expect(where(2, 100, 88)).toBe('sections/a.tex:7');
  expect(where(3, 100, 100)).toBeNull();
});

test("a build run in the root file's folder (-cd) names files above it by their project path", () => {
  const sync = parseSyncTeX(
    [
      'SyncTeX Version:1',
      'Input:1:/work/paper/./main.tex',
      'Input:2:/work/paper/../shared/macros.tex',
      'Input:3:/work/paper/sections/../sections/./a.tex',
      'Input:4:/work/../etc/outside.tex',
      'Output:pdf',
      'Content:',
      '',
    ].join('\n'),
  );
  expect(sync.inputs).toEqual([
    'paper/main.tex',
    'shared/macros.tex',
    'paper/sections/a.tex',
    'etc/outside.tex',
  ]);
});

// A paragraph typed on lines 3 to 5 and ended by the blank line 6, set in two lines. As the
// engine wrote it down: each line box is tagged with line 6, and so are the `x` records at its
// start, before the first word's own records.
const WRAPPED = [
  'SyncTeX Version:1',
  'Input:1:/work/./a.tex',
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'Content:',
  '{1',
  `(1,6:${at(72, 100)}:${pt(228)},${pt(8)},${pt(2)}`,
  `x1,6:${at(80, 100)}`,
  `x1,6:${at(100, 100)}`,
  `k1,3:${at(104, 100)}:${pt(4)}`,
  `x1,3:${at(111, 100)}`,
  `k1,4:${at(280, 100)}:${pt(4)}`,
  ')',
  `(1,6:${at(72, 112)}:${pt(228)},${pt(8)},${pt(2)}`,
  `x1,6:${at(103, 112)}`,
  `x1,6:${at(125, 112)}`,
  `k1,4:${at(128, 112)}:${pt(3)}`,
  `x1,4:${at(142, 112)}`,
  `k1,5:${at(250, 112)}:${pt(3)}`,
  ')',
  // A line with nothing of its own but the paragraph's end.
  `(1,6:${at(72, 124)}:${pt(228)},${pt(8)},${pt(2)}`,
  ')',
  '}1',
  'Postamble:',
  '',
].join('\n');

test('a click at the left edge of a wrapped line is on that line, not where the paragraph ends', () => {
  const sync = parseSyncTeX(WRAPPED);
  const line = (x: number, y: number) => toSource(sync, 1, x, y)?.line;
  // The edge of the first line, and of the second, whose first records say line 6.
  expect(line(73, 98)).toBe(3);
  expect(line(73, 110)).toBe(4);
  expect(line(96, 110)).toBe(4);
  // Mid-line, on either side of a word.
  expect(line(150, 110)).toBe(4);
  expect(line(260, 110)).toBe(5);
  expect(line(200, 98)).toBe(3);
  // A box with nothing of its own is answered by the line above, at its end.
  expect(line(120, 122)).toBe(5);
  // Never the paragraph's end while a neighbour can say.
  expect(toSource(sync, 1, 73, 122)?.line).toBe(5);
});

test('a point in the margin, far from anything, is not answered', () => {
  const sync = parseSyncTeX(WRAPPED);
  expect(toSource(sync, 1, 400, 110)).toBeNull();
  expect(toSource(sync, 1, 100, 400)).toBeNull();
  expect(toSource(sync, 1, 20, 110)).toBeNull();
});

// A paragraph typed in a.tex, lines 3 and 4, and ended by the first line of m.tex, a heading: the
// paragraph's line box and what it holds at its start and end are tagged m.tex:1. The heading's
// own box holds only records of its own line. Then a blank line a.tex:5 that only ended a
// paragraph, and a paragraph of one line, a.tex:7.
const ENDED = [
  'SyncTeX Version:1',
  'Input:1:/work/./a.tex',
  'Input:2:/work/./m.tex',
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'Content:',
  '{1',
  `(2,1:${at(72, 100)}:${pt(228)},${pt(8)},${pt(2)}`,
  `x2,1:${at(72, 100)}`,
  `k1,3:${at(100, 100)}:${pt(4)}`,
  `x1,4:${at(150, 100)}`,
  `k2,1:${at(290, 100)}:${pt(4)}`,
  ')',
  `(2,1:${at(72, 140)}:${pt(228)},${pt(8)},${pt(2)}`,
  `x2,1:${at(72, 140)}`,
  `g2,1:${at(90, 140)}`,
  ')',
  `(1,5:${at(72, 180)}:${pt(228)},${pt(8)},${pt(2)}`,
  `x1,5:${at(72, 180)}`,
  `k1,3:${at(100, 180)}:${pt(4)}`,
  ')',
  `(1,7:${at(72, 200)}:${pt(228)},${pt(8)},${pt(2)}`,
  `g1,7:${at(80, 200)}`,
  ')',
  '}1',
  'Postamble:',
  '',
].join('\n');

test('what a box that ends a paragraph holds is stale, and a heading that ends one is not', () => {
  const sync = parseSyncTeX(ENDED);
  const stale = sync.records.map(
    (r) => `${sync.inputs[r.file]}:${r.line}${r.kind}${r.stale ? '*' : ''}`,
  );
  expect(stale).toEqual([
    'm.tex:1(*',
    'm.tex:1x*',
    'a.tex:3k',
    'a.tex:4x',
    'm.tex:1k*',
    'm.tex:1(',
    'm.tex:1x',
    'm.tex:1g',
    'a.tex:5(*',
    'a.tex:5x*',
    'a.tex:3k',
    'a.tex:7(',
    'a.tex:7g',
  ]);
  // The heading is where its own box is, not in the paragraph before it that carries its tag.
  const heading = toPdf(sync, 'm.tex', 1)!;
  expect(Math.round(heading.y)).toBe(132);
  expect(toSource(sync, 1, 73, 138)).toMatchObject({ path: 'm.tex', line: 1 });
  // A blank line that only ended a paragraph made nothing: the next line that did.
  expect(toPdf(sync, 'a.tex', 5)).toMatchObject({ line: 7 });
});
