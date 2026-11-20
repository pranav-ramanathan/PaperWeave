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
  // Past the end: the last line that made something.
  expect(toPdf(sync, 'main.tex', 99)).toMatchObject({ line: 6 });
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
  // In the margin, in no line of text: the nearest thing on the page.
  expect(where(1, 20, 300)).toBe('main.tex:5');
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
