import { expect, test } from 'vitest';
import { contained, containedNear, WINDOW_CAP } from './contained.ts';
import { DEFAULT_TRANSPARENT, parse, textblocks } from './parse.ts';
import { type Rng, rng, soup } from './testutil.ts';

const N = Number(process.env.FUZZ ?? 3000);

const PARAS = [
  'Plain words \\cite{a} and \\ref{b} with \\emph{some} text.',
  '\\section{Heading $x$}',
  '\\begin{itemize}\n\\item one \\cite{c}\n\\item two\n\\end{itemize}',
  'Math $a + b$ and \\textbf{bold \\sys{}} then more.',
  'Unclosed $ math here and \\cite{d} too',
  '\\begin{equation}\nx = 1\n\\end{equation}',
  '\\begin{align}\na &= b\n\\end{align}',
  '$$ y = 2 $$',
];
const REPLACEMENTS = [
  '\\sys',
  '\\cite{z}',
  'x y',
  '$',
  '\\\\\n\n',
  '\\begin{equation}\ny\n\\end{equation}',
  '\\begin{equation}\ny',
  '$$ z $$',
  '$$ z',
  '{',
  '\n\nnew',
  '\\section{',
  ' ',
  'a\\begin{document}b',
];

function document(r: Rng, plain: boolean) {
  const out: string[] = [];
  for (let i = 0, n = 3 + r.int(12); i < n; i++)
    out.push(!plain && r.int(3) === 0 ? soup(r, 1 + r.int(12)) : r.pick(PARAS));
  const head = r.int(2) ? '\\documentclass{article}\n\\begin{document}\n\n' : '';
  return head + out.join(r.pick(['\n\n', '\n\n', '\n \n', '\n']));
}

/** Where each inline atom that is not a definition, and each display formula, sits in the source. */
function atoms(src: string) {
  const out: [number, number][] = [];
  for (const b of parse(src).blocks) {
    if (b.body.kind === 'math') out.push([b.start, b.start + b.body.text.length]);
    for (const tb of textblocks(b.body))
      for (const q of tb)
        if (q.k === 'atom' && q.type !== 'def') out.push([b.start + q.s, b.start + q.e]);
  }
  return out;
}

test('containedNear agrees with the full-file check', () => {
  let tried = 0;
  let accepted = 0;
  for (let seed = 0; seed < N; seed++) {
    const r = rng(seed);
    // Odd seeds mix in random soup, which can hold a verbatim or math span left open across a
    // blank line; even seeds are ordinary documents.
    const plain = seed % 2 === 0;
    const src = document(r, plain);
    const found = atoms(src);
    if (!found.length) continue;
    const [from, to] = r.pick(found);
    const rep = r.int(4) === 0 ? soup(r, 1 + r.int(4)) : r.pick(REPLACEMENTS);
    const after = src.slice(0, from) + rep + src.slice(to);
    const full = contained(
      parse(src, DEFAULT_TRANSPARENT),
      parse(after, DEFAULT_TRANSPARENT),
      from,
      to - from,
      rep.length,
    );
    const near = containedNear(src, from, to - from, rep);
    tried++;
    if (full) accepted++;
    // Accepting what the full check refuses is the unsafe direction and is never allowed. On soup
    // the window may refuse what the full check accepts, because it can start inside a span that
    // is left open across a blank line (a verbatim, a $$ or an environment with no end), and read
    // that text as prose. On ordinary documents the two always agree.
    if (near && !full)
      throw new Error(`seed ${seed}: the window accepted what the full check refused`);
    if (full && !near && plain)
      throw new Error(`seed ${seed}: the window refused an ordinary document`);
  }
  // The loop must exercise both answers, or agreement means nothing.
  if (N >= 1000) {
    expect(accepted).toBeGreaterThan(tried / 20);
    expect(tried - accepted).toBeGreaterThan(tried / 20);
  }
});

test('containedNear catches a spill into the next paragraph, far from either end', () => {
  const para = 'Some words \\cite{a} here.';
  const src = `${Array(200).fill(para).join('\n\n')}\n\nBefore \\sys{}after.\n\n${Array(200).fill(para).join('\n\n')}`;
  const from = src.indexOf('\\sys{}');
  expect(containedNear(src, from, 6, '\\sys')).toBe(false);
  expect(containedNear(src, from, 6, '\\sys{}')).toBe(true);
});

test('containedNear refuses, and does not parse, a paragraph past the cap', () => {
  const src = `a \\sys{} ${'word '.repeat(WINDOW_CAP / 4)}`;
  expect(containedNear(src, 2, 6, '\\sys{}')).toBe(false);
});

test('containedNear starts no window at a stray \\end{document} or inside the preamble', () => {
  const lone =
    'Throughout, $x$ and ]\\\\end{document} is the length.\n\nSecond \\sys{} paragraph.\n\nThird.';
  const src = `${lone}\n\n${lone}\n\n${lone}`;
  const from = src.lastIndexOf('\\sys{}');
  expect(containedNear(src, from, 6, '\\cite{k}')).toBe(true);
  const pre = `\\documentclass{article}\n\\newcommand{\\sys}{S}\n\\begin{document}\n\nUse \\sys{} now.\n\nMore.\n`;
  expect(containedNear(pre, pre.indexOf('\\sys{} now'), 6, '\\cite{k}')).toBe(true);
  expect(containedNear(pre, pre.indexOf('\\sys{}}'), 6, '\\cite{k}')).toBe(false);
  // A second \\begin{document} is only text, as in the whole file.
  expect(containedNear(pre, pre.indexOf('\\sys{} now'), 6, 'a\\begin{document}b')).toBe(
    contained(
      parse(pre),
      parse(pre.replace('\\sys{} now', 'a\\begin{document}b now')),
      pre.indexOf('\\sys{} now'),
      6,
      19,
    ),
  );
});

test('a display formula rewritten to another display formula is contained; one missing its end is not', () => {
  const src = 'Before.\n\n\\begin{equation}\nx = 1\n\\end{equation}\n\nAfter \\cite{a}.\n';
  const from = src.indexOf('\\begin{equation}');
  const was = '\\begin{equation}\nx = 1\n\\end{equation}'.length;
  const check = (rep: string) => {
    const after = src.slice(0, from) + rep + src.slice(from + was);
    const full = contained(parse(src), parse(after), from, was, rep.length);
    // The window must not accept what the full check refuses.
    if (containedNear(src, from, was, rep)) expect(full).toBe(true);
    return full;
  };
  expect(check('\\begin{equation}\ny = 2\n\\end{equation}')).toBe(true);
  expect(check('\\[ y \\]')).toBe(true);
  expect(check('\\begin{equation}\ny = 2')).toBe(false);
  expect(check('$ y $')).toBe(false);
  expect(
    check('\\begin{equation}\ny\n\\end{equation}\n\n\\begin{equation}\nz\n\\end{equation}'),
  ).toBe(false);
  expect(containedNear(src, from, was, '\\begin{equation}\ny = 2\n\\end{equation}')).toBe(true);
});
