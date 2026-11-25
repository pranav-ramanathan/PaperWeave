// The parser memoizes its look-aheads (see parse.ts). `parse.reference.ts` is the parser as it was
// before, copied unchanged (its one difference is that THIN is written as the U+2009 character
// itself, not as an escape); every tree must be the same as the old parser's.
import { expect, test } from 'vitest';
import { decodeFile } from './index.ts';
import { parse, reparse } from './parse.ts';
import { parse as parseOld, reparse as reparseOld } from './parse.reference.ts';
import { fixtureFiles, rng, soup, type Rng } from './testutil.ts';

const N = Number(process.env.DIFF ?? 4000);

/** The tokens the memoized look-aheads care about, with words and blank lines between them. */
const TOKENS = [
  ...['\\cite[', '\\cite{', '\\cite<', '\\citep(', '\\cites(', '\\ref[', '\\ref{', '\\crefrange{'],
  ...['[', ']', '{', '}', '(', ')', '<', '>', '$', '$$', '\\(', '\\)', '\\[', '\\]'],
  ...['\\begin{x}', '\\end{x}', '\\begin{y}', '\\end{y}', '\\begin{verbatim}', '\\end{verbatim}'],
  ...['\\begin{itemize}', '\\end{itemize}', '\\item ', '\\begin{abstract}', '\\begin{abstract}['],
  ...['%', '%\n', '\n', '\n\n', '\n \n', ' ', '\t', '\\\\', '\\%', '\\{', '\\}'],
  ...['\\verb|', '\\verb*!', '\\lstinline[', '\\lstinline{', '\\mintinline{', '\\url{', '\\href{'],
  ...['\\emph{', '\\textbf{', '{\\em ', '{\\bf ', '\\section{', '\\section[', '\\subsection*{'],
  ...['\\newcommand{\\x}[', '\\def\\x{', '\\end{document}', '\\label{', '\\foo[', '\\foo{'],
  ...['word', 'two words', 'x', 'a=b', '|', '!', '"'],
];
const tokens = (r: Rng, n: number) =>
  Array.from({ length: n }, () => r.pick(TOKENS)).join(r.int(3) === 0 ? ' ' : '');

/** Throws, naming `what` (the seed), if the two parsers' trees for `src` differ. */
function same(what: string, src: string) {
  const a = parse(src);
  const b = parseOld(src);
  const x = JSON.stringify(a.blocks);
  const y = JSON.stringify(b.blocks);
  if (a.src !== b.src || x !== y) {
    const i = b.blocks.findIndex((q, j) => JSON.stringify(q) !== JSON.stringify(a.blocks[j]));
    throw new Error(
      `${what}: trees differ at block ${i}\nnew ${JSON.stringify(a.blocks[i])}\nold ${JSON.stringify(b.blocks[i])}\n${JSON.stringify(src)}`,
    );
  }
  expect([...a.transparent]).toEqual([...b.transparent]);
}

test('every fixture parses to the tree the old parser gave', () => {
  let count = 0;
  for (const [path, bytes] of Object.entries(fixtureFiles())) {
    const d = decodeFile(bytes);
    if (!d.editable) continue;
    same(path, d.text);
    count++;
  }
  expect(count).toBeGreaterThan(20);
});

test('random LaTeX-ish text parses to the tree the old parser gave', () => {
  for (let seed = 0; seed < N; seed++) {
    const r = rng(seed);
    // Short strings hit every branch; the longer ones nest and repeat what the short ones cannot.
    const src =
      seed % 4 === 3 ? soup(r, 1 + r.int(60)) : tokens(r, 1 + r.int(seed % 4 === 2 ? 120 : 30));
    same(`seed ${seed}`, src);
  }
});

test('random text at the edges of the memos parses to the tree the old parser gave', () => {
  // Many of one opener, then a few closers, in a paragraph or across blank lines.
  const openers = [
    '\\cite[',
    '[',
    '{',
    '$',
    '\\(',
    '\\begin{x}',
    '\\url{',
    '\\verb|',
    '\\cites(',
    '\\[',
    '$$',
  ];
  const closers = [']', '}', '$', '\\)', '\\end{x}', '|', ')', '\\]', '$$', '\n\n', '%'];
  for (let seed = 0; seed < Math.ceil(N / 4); seed++) {
    const r = rng(1_000_000 + seed);
    const parts: string[] = [];
    for (let k = 1 + r.int(4); k > 0; k--) {
      parts.push(r.pick(openers).repeat(1 + r.int(30)));
      parts.push(tokens(r, r.int(6)));
      parts.push(r.pick(closers).repeat(r.int(4)));
    }
    same(`seed ${1_000_000 + seed}`, parts.join(r.int(2) ? '' : ' '));
  }
});

test('incremental reparse gives the old parser trees after every edit', () => {
  for (let seed = 0; seed < Math.ceil(N / 40); seed++) {
    const r = rng(2_000_000 + seed);
    let src = tokens(r, 40);
    let inc = parse(src);
    let old = parseOld(src);
    for (let step = 0; step < 30; step++) {
      const at = r.int(src.length + 1);
      src = src.slice(0, at) + tokens(r, r.int(3)) + src.slice(at + r.int(6));
      inc = reparse(inc, src);
      old = reparseOld(old, src);
      if (JSON.stringify(inc.blocks) !== JSON.stringify(old.blocks))
        throw new Error(`seed ${2_000_000 + seed} step ${step}: ${JSON.stringify(src)}`);
    }
  }
});
