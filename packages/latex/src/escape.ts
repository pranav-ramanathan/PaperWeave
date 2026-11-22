// Plain text into LaTeX source: what a person typed or a checker suggested, made safe to insert.
import { NBSP } from './parse.ts';

const ESCAPE: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  // pdfLaTeX's default encoding prints these as ¡ ¿ —; the commands are right in every encoding.
  '<': '\\textless{}',
  '>': '\\textgreater{}',
  '|': '\\textbar{}',
  [NBSP]: '~',
  '\n': ' ',
  '\r': ' ',
  '\t': ' ',
};
for (const c of '%&$#_{}') ESCAPE[c] = '\\' + c;
export const escape = (s: string) => s.replace(/[\\~^<>|\xa0\n\r\t%&$#_{}]/g, (c) => ESCAPE[c]);
