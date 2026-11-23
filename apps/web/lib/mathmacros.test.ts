import { mathMacros } from '@paperweave/latex';
import katex from 'katex';
import { expect, test } from 'vitest';

const draw = (tex: string, macros: Record<string, string>) =>
  katex
    .renderToString(tex, { throwOnError: true, macros: { ...macros } })
    // What is drawn, not the source that KaTeX keeps beside it.
    .replace(/<annotation[\s\S]*?<\/annotation>/, '')
    .replace(/<[^>]*>/g, '');

test('an argument a macro does not use is dropped when the formula is drawn', () => {
  const macros = mathMacros(
    {
      'main.tex':
        '\\documentclass{article}\n\\newcommand{\\zero}[1]{0}\n\\newcommand{\\hide}[1]{}\n\\begin{document}\n\\end{document}\n',
    },
    'main.tex',
  );
  expect(draw('\\zero{x}y', macros)).toBe('0y0y'); // MathML, then the drawing
  expect(draw('a\\hide{zzz}b', macros)).toBe('abab');
});
