import { expect, test } from 'vitest';
import { describeImport, papers, summarizeImport } from './import.ts';

const doc = (pre: string, body = 'Hi.') =>
  `\\documentclass{article}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`;
const compiler = (files: Record<string, string>) =>
  describeImport(Object.entries(files).map(([path, t]) => ({ path, bytes: Buffer.from(t) }))).report
    .compiler;

test('a package that needs XeTeX, loaded from a preamble file the root inputs', () => {
  expect(
    compiler({
      'main.tex': doc('\\input{preamble}'),
      'preamble.tex': '\\usepackage[no-math]{fontspec}\n',
    }),
  ).toBe('xelatex');
});

test('a package loaded by the paper own class or style, through RequirePackage', () => {
  expect(
    compiler({
      'main.tex': '\\documentclass{my}\n\\begin{document}Hi.\\end{document}\n',
      'my.cls': '\\LoadClass{article}\n\\RequirePackage{fontspec}\n',
    }),
  ).toBe('xelatex');
  expect(
    compiler({
      'main.tex': doc('\\usepackage{my}'),
      'my.sty': '\\RequirePackage{amsmath, unicode-math}\n',
    }),
  ).toBe('xelatex');
});

test('a commented-out package does not count', () => {
  expect(compiler({ 'main.tex': doc('% \\usepackage{fontspec}') })).toBe('pdflatex');
  expect(compiler({ 'main.tex': doc('\\input{p}'), 'p.tex': '% \\usepackage{fontspec}\n' })).toBe(
    'pdflatex',
  );
});

test('ctex, its classes and luatexja are recognised', () => {
  expect(compiler({ 'main.tex': doc('\\usepackage{ctex}') })).toBe('xelatex');
  expect(
    compiler({ 'main.tex': '\\documentclass{ctexart}\n\\begin{document}\\end{document}\n' }),
  ).toBe('xelatex');
  expect(compiler({ 'main.tex': doc('\\usepackage[a]{amsmath,luatexja}') })).toBe('lualatex');
});

test('an include after \\begin{document}, or a class the paper does not hold, is not followed', () => {
  expect(
    compiler({
      'main.tex': doc('', '\\input{late}'),
      'late.tex': '\\usepackage{fontspec}\n',
    }),
  ).toBe('pdflatex');
  expect(
    compiler({ 'main.tex': doc('\\usepackage{fontspec}', '').replace('fontspec', 'graphicx') }),
  ).toBe('pdflatex');
});

test('the magic comment wins', () => {
  expect(
    compiler({ 'main.tex': '% !TEX program = lualatex\n' + doc('\\usepackage{fontspec}') }),
  ).toBe('lualatex');
  expect(compiler({ 'main.tex': '% !TEX program = pdflatex\n' + doc('\\usepackage{ctex}') })).toBe(
    'pdflatex',
  );
});

const notes = (files: Record<string, string>) =>
  describeImport(Object.entries(files).map(([path, t]) => ({ path, bytes: Buffer.from(t) }))).report
    .notes;
const pic = (name: string) => doc('\\usepackage{graphicx}', `\\includegraphics{${name}}`);

test('an EPS picture is noted, by what the compiler does with it', () => {
  expect(notes({ 'main.tex': pic('figs/a.eps'), 'figs/a.eps': '%!PS' }).join('\n')).toContain(
    'The picture figs/a.eps is an EPS file, which pdfLaTeX cannot place here: the PDF has a box with the name instead. Convert it to PDF.',
  );
  expect(
    notes({
      'main.tex': doc('\\usepackage{fontspec}\\usepackage{graphicx}', '\\includegraphics{a.eps}'),
      'a.eps': '%!PS',
    }).join('\n'),
  ).toContain('XeLaTeX cannot convert here: the build fails');
});

test('no EPS note without an EPS picture, or when its PDF conversion ships with the paper', () => {
  expect(notes({ 'main.tex': pic('a.pdf'), 'a.pdf': '%PDF' }).join('\n')).not.toMatch(/EPS/);
  expect(
    notes({ 'main.tex': pic('a.eps'), 'a.eps': '%!PS', 'a-eps-converted-to.pdf': '%PDF' }).join(
      '\n',
    ),
  ).not.toMatch(/EPS/);
});

test('the report opens with one line of what was found', () => {
  const { report } = describeImport([
    { path: 'main.tex', bytes: Buffer.from(doc('\\input{defs}', 'Some prose here.')) },
    { path: 'defs.tex', bytes: Buffer.from('\\newcommand{\\x}{y}\n') },
    { path: 'fig.png', bytes: Buffer.from([0, 1, 2]) },
  ]);
  expect(summarizeImport(report)).toBe(
    'Imported 3 files: root main.tex, compiler pdflatex, 100% of body prose editable visually, 1 source-only file.',
  );
});

test('files LaTeX cannot name are listed, sorted, and ordinary ones are not', () => {
  const { report } = describeImport([
    { path: 'main.tex', bytes: Buffer.from(doc('', 'Some prose here.')) },
    { path: 'my{dir}/x.tex', bytes: Buffer.from('x') },
    { path: 'figs/a#1.png', bytes: Buffer.from([0, 1]) },
    { path: 'figs/b.png', bytes: Buffer.from([0, 1]) },
  ]);
  expect(report.unnamable).toEqual(['figs/a#1.png', 'my{dir}/x.tex']);
});

test('a main file with one CRLF among LF lines is a paper, and the report says its line endings are mixed', () => {
  const main = Buffer.from(doc('', 'One.\r\nTwo.'));
  const bib = Buffer.from('@book{a, title={T}}\n');
  const found = papers(
    [
      { path: 'main.tex', bytes: main },
      { path: 'refs.bib', bytes: bib },
    ],
    [],
  );
  expect(found).toHaveLength(1);
  const { report } = describeImport([
    { path: 'main.tex', bytes: main },
    { path: 'refs.bib', bytes: bib },
  ]);
  expect(report.root).toBe('main.tex');
  expect(report.files.find((f) => f.path === 'main.tex')!.readonly).toBeUndefined();
  expect(report.notes.join('\n')).toContain('Line endings are mixed in main.tex:');
  const plain = describeImport([{ path: 'main.tex', bytes: Buffer.from(doc('')) }]).report;
  expect(plain.notes.join('\n')).not.toMatch(/Line endings are mixed/);
});

test('a report lists at most 200 left-out files, the ones worth reading first, and counts the rest', () => {
  const generic = 'not a file type a paper uses';
  const rows = Array.from({ length: 250 }, (_, i) => ({ path: `n${i}.docx`, reason: generic }));
  const picture = {
    path: 'x.svg',
    reason: 'LaTeX cannot use this picture as it is: convert it to PDF or PNG',
  };
  const entries = [{ path: 'main.tex', bytes: Buffer.from(doc('', 'Hi.')) }];
  const { report } = describeImport(entries, [...rows, picture]);
  expect(report.skipped).toHaveLength(200);
  expect(report.skipped[0]).toEqual(picture);
  expect(report.skippedMore).toBe(51);
  const few = describeImport(entries, [rows[0], picture, rows[1]]).report;
  expect(few.skipped.map((s) => s.path)).toEqual(['n0.docx', 'x.svg', 'n1.docx']);
  expect(few.skippedMore).toBeUndefined();
});

test('the latexmkrc note is kept when the list is cut', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    path: `n${i}.docx`,
    reason: 'not a file type a paper uses',
  }));
  const { report } = describeImport(
    [{ path: 'main.tex', bytes: Buffer.from(doc('', 'Hi.')) }],
    [...rows, { path: 'latexmkrc', reason: 'build script, never run' }],
  );
  expect(report.notes.join(' ')).toMatch(/latexmkrc/); // guard
});
