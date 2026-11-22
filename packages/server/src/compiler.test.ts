import { expect, test } from 'vitest';
import { describeImport, summarizeImport } from './import.ts';

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
