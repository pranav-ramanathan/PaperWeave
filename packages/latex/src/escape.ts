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
  // babel (German, Dutch, Spanish...) makes " a shorthand that swallows the next letter.
  '"': '\\symbol{34}',
  [NBSP]: '~',
  '\n': ' ',
  '\r': ' ',
  '\t': ' ',
};
for (const c of '%&$#_{}') ESCAPE[c] = '\\' + c;
export const escape = (s: string) => s.replace(/[\\~^<>|"\xa0\n\r\t%&$#_{}]/g, (c) => ESCAPE[c]);

/**
 * Whether a comment is open at the end of `line`: a % that is not escaped and is not written
 * inside \verb, \lstinline, \mintinline, or the address of \url, \href, \nolinkurl or \path.
 */
export function commentOpen(line: string) {
  // Index after the {...} group at `at`, braces balanced; -1 if it does not close in the line.
  const group = (at: number) => {
    for (let d = 0, i = at; i < line.length; i++) {
      if (line[i] === '{') d++;
      else if (line[i] === '}' && --d === 0) return i + 1;
    }
    return -1;
  };
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%') return true;
    if (line[i] !== '\\') continue;
    const name = /^\\([a-zA-Z]+)\*?/.exec(line.slice(i, i + 24));
    if (!name) {
      i++; // an escaped character: \% is no comment
      continue;
    }
    let p = i + name[0].length;
    let end: number;
    if (name[1] === 'verb' || name[1] === 'lstinline' || name[1] === 'mintinline') {
      if (name[1] !== 'verb' && line[p] === '[') p = line.indexOf(']', p) + 1 || line.length;
      if (name[1] === 'mintinline' && line[p] === '{') p = group(p) < 0 ? line.length : group(p);
      const open = line[p];
      if (open === undefined) return false;
      if (open === '{' && name[1] !== 'verb') end = group(p);
      else if (!/[\s\w]/.test(open)) end = line.indexOf(open, p + 1) + 1 || -1;
      else continue; // no code written here: a macro of the same name, or a stray command
    } else if (['url', 'nolinkurl', 'path', 'href'].includes(name[1]) && line[p] === '{')
      end = group(p);
    else {
      i = p - 1;
      continue;
    }
    // The argument runs to the end of the line, so nothing after it is a comment either.
    if (end < 0) return false;
    i = end - 1;
  }
  return false;
}
