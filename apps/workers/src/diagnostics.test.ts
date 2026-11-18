import { expect, test } from 'vitest';
import { diagnostics } from './compile.ts';

test('errors are read from a log with their place, and fatal ones without', () => {
  const log = [
    'This is pdfTeX, Version 3.141592653',
    './sections/intro.tex:12: Undefined control sequence.',
    'l.12 \\nosuchmacro',
    "LaTeX Warning: Reference `sec:x' on page 1 undefined on input line 7.",
    '!pdfTeX error: pdflatex (file ./figures/dot.png): libpng error: Not a PNG file',
    ' ==> Fatal error occurred, no output PDF file produced!',
  ].join('\n');
  expect(diagnostics(log)).toEqual([
    {
      severity: 'error',
      file: 'sections/intro.tex',
      line: 12,
      message: 'Undefined control sequence.',
    },
    {
      severity: 'error',
      message: 'pdflatex (file ./figures/dot.png): libpng error: Not a PNG file',
    },
    { severity: 'warning', message: "Reference `sec:x' on page 1 undefined", line: 7 },
  ]);
});

test('a warning is placed in the file TeX was reading when it wrote it', () => {
  // The shape of a real log: files nested in brackets, with other brackets around them.
  const log = [
    '**main.tex',
    '(./main.tex',
    'LaTeX2e <2022-11-01> patch level 1',
    '(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls',
    'Document Class: article 2022/07/02 v1.4n Standard LaTeX document class',
    "Package hyperref Warning: Option `x' has no effect on input line 41.",
    ') (./macros.tex) (./main.aux)',
    "LaTeX Warning: Citation `early' on page 1 undefined on input line 9.",
    '(./sections/intro.tex',
    'Overfull \\hbox (5.0pt too wide) in paragraph at lines 3--4',
    '[]\\OT1/cmr/m/n/10 a paragraph quoted from the paper) with a stray bracket',
    "LaTeX Warning: Reference `sec:nowhere' on page 1 undefined on input line 19.",
    ') (./sections/method.tex (./tables/ablation.tex',
    "LaTeX Warning: Reference `tab:x' on page 2 undefined on input line 4.",
    ')',
    'Package caption Warning: Unused option on input line 30.',
    ')) [1] (./main.aux)',
    'LaTeX Warning: There were undefined references.',
    ')',
  ].join('\n');
  expect(diagnostics(log).map((d) => [d.file, d.line, d.message.split(' ')[0]])).toEqual([
    // Written while reading a file of TeX's own: not one of the paper's.
    [undefined, 41, 'Option'],
    ['main.tex', 9, 'Citation'],
    ['sections/intro.tex', 19, 'Reference'],
    ['tables/ablation.tex', 4, 'Reference'],
    // Back in the file that brought the table in.
    ['sections/method.tex', 30, 'Unused'],
    // No line, so no place.
    [undefined, undefined, 'There'],
  ]);
});
