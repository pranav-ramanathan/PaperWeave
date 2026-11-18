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
