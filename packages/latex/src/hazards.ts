// What a typed replacement would break once it is written into the source as LaTeX.
import { commentOpen, escape } from './escape.ts';
import { parse, textblocks, type Parsed } from './parse.ts';

const HEAD = '\\begin{document}\n';
const DOC = '\\begin{document}';
const REACH = 20000;
const LIMIT = 40000;

type Found = {
  errors: { s: number; e: number; message: string }[];
  atoms: { s: number; e: number; src: string }[];
};

function scan(src: string): Found {
  const p: Parsed = parse(src);
  const found: Found = { errors: [], atoms: [] };
  for (const b of p.blocks) {
    if (b.body.kind === 'error')
      found.errors.push({ s: b.start, e: b.start + b.body.text.length, message: b.body.message });
    for (const piece of textblocks(b.body).flat())
      if (piece.k === 'atom')
        found.atoms.push({
          s: b.start + piece.s,
          e: b.start + piece.e,
          src: src.slice(b.start + piece.s, b.start + piece.e),
        });
  }
  return found;
}

const open = (s: string) => commentOpen(s.slice(s.lastIndexOf('\n') + 1));

/**
 * What accepting `replacement` for text[from, to) would break as LaTeX. Advisory and pure: a
 * comment character is found anywhere in the file; unfinished groups and bare & # _ ^ only in the
 * paragraph around the edit, and not in raw blocks, the preamble or lists with blank lines.
 */
export function replacementHazards(
  text: string,
  from: number,
  to: number,
  replacement: string,
): string[] {
  const out: string[] = [];
  const expected = text.slice(from, to);
  const head = text.slice(text.lastIndexOf('\n', from - 1) + 1, from);
  if (open(head + replacement) && !open(head + expected)) {
    const nl = text.indexOf('\n', to);
    const rest = text.slice(to, nl < 0 ? text.length : nl).trim();
    out.push(
      rest
        ? `It has a % that is not written \\%: LaTeX reads the rest of the line as a comment, so \u201c${rest.length > 60 ? rest.slice(0, 60) + '\u2026' : rest}\u201d would be left out of the PDF.`
        : 'It ends in a % that is not written \\%: LaTeX reads it as the start of a comment and joins this line to the next.',
    );
  }

  // The window: the paragraph around the edit, never the whole file.
  const lo = Math.max(0, from - REACH);
  const brk = /\n[ \t]*\n/g;
  let s = -1;
  for (let m = brk.exec(text.slice(lo, from)); m; m = brk.exec(text.slice(lo, from)))
    s = lo + m.index + m[0].length;
  if (s < 0) {
    if (lo > 0) return out;
    s = 0;
  }
  const d = text.indexOf(DOC);
  if (d >= 0) {
    if (from < d + DOC.length) return out;
    s = Math.max(s, d + DOC.length);
  }
  const tail = /\n[ \t]*\n/.exec(text.slice(to));
  const e = tail ? to + tail.index : text.length;
  if (e - s > LIMIT) return out;

  const base = HEAD.length - s;
  const before = scan(HEAD + text.slice(s, e));
  const after = scan(HEAD + text.slice(s, from) + replacement + text.slice(to, e));
  const [ra, rb] = [from + base, from + base + replacement.length];
  const [xa, xb] = [from + base, to + base];

  const bad = after.errors.find((b) => b.s <= rb && b.e >= ra);
  if (bad && !before.errors.some((b) => b.s <= xb && b.e >= xa)) {
    out.push(
      `It leaves LaTeX unfinished (${bad.message}): the paragraph could not be built as written. Write \\$ for a dollar sign, \\{ and \\} for braces.`,
    );
    return out;
  }
  for (const c of '&#_^') {
    const inAfter = after.atoms.some((a) => a.src === c && a.s >= ra && a.e <= rb);
    const inBefore = before.atoms.some((a) => a.src === c && a.s >= xa && a.e <= xb);
    if (inAfter && !inBefore)
      out.push(`It has a bare ${c}: LaTeX stops with an error there. Write ${escape(c)}.`);
  }
  return out;
}
