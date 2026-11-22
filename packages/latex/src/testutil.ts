// Seeded randomness for tests: a failure prints its seed and replays exactly.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type Parsed, textblocks } from './parse.ts';

export const FIXTURES = join(import.meta.dirname, '../../../fixtures');

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(xs: readonly T[]) => xs[int(xs.length)] };
}
export type Rng = ReturnType<typeof rng>;

/** Every fixture file as bytes, keyed by path relative to fixtures/. */
export function fixtureFiles(dir = FIXTURES): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(FIXTURES, p)] = readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

const FRAGMENTS = [
  ...['\\begin{itemize}', '\\end{itemize}', '\\item ', '\\section{', '\\subsection*{', '}', '{'],
  ...['$', '$$', '%', '\n', '\n\n', ' ', '\\emph{', '\\textbf{', '\\[', '\\]', '\\(', '\\)'],
  ...['\\begin{document}', '\\end{document}', '\\verb|', '\\cite{', '\\ref{', '[', ']', '\\\\'],
  ...[
    '\\begin{equation}',
    '\\end{equation}',
    '\\begin{abstract}',
    '\\end{abstract}',
    '\\begin{frontmatter}',
    '~',
    '\\%',
  ],
  ...['\\foo', '\\begin{verbatim}', '\\end{verbatim}', '&', '_', '^', '#', '\\', '*', '\t'],
  ...['\\url{', '%20', '\\href{', '\\text{', '\\lstinline|', '\\crefrange{'],
  ...['$\\d', '$\\d}', '\\(lta$', '$\\delta$', '\\😀', '\\😀 x'],
  ...['word', 'a', 'é', '😀', 'two words', '\\label{x}', '\\textbackslash{}', '\\begin{', '\\end{'],
];
export const fragment = (r: Rng) => r.pick(FRAGMENTS);
export const soup = (r: Rng, n: number) => Array.from({ length: n }, () => fragment(r)).join('');

/** Throws if any block or piece boundary of p falls between the two halves of a surrogate pair. */
export function assertNoSplitPair(p: Parsed) {
  const split = (at: number) => {
    const a = p.src.charCodeAt(at - 1);
    const b = p.src.charCodeAt(at);
    return a >= 0xd800 && a < 0xdc00 && b >= 0xdc00 && b < 0xe000;
  };
  for (const b of p.blocks) {
    if (split(b.start)) throw new Error(`block starts inside a surrogate pair at ${b.start}`);
    for (const piece of textblocks(b.body).flat())
      for (const at of [piece.s, piece.e])
        if (split(b.start + at)) throw new Error(`piece boundary inside a pair at ${b.start + at}`);
  }
}

/** Throws unless every source character belongs to exactly one piece of exactly one block. */
export function assertLossless(p: Parsed) {
  assertNoSplitPair(p);
  let at = 0;
  for (const b of p.blocks) {
    if (b.start !== at) throw new Error(`block gap at ${at}`);
    if (!b.body.text.length) throw new Error(`empty block at ${at}`);
    if (p.src.slice(at, at + b.body.text.length) !== b.body.text) throw new Error(`text at ${at}`);
    const tbs = textblocks(b.body);
    if (tbs.length) {
      let q = 0;
      for (const piece of tbs.flat()) {
        if (piece.s !== q || piece.e < piece.s) throw new Error(`piece gap at ${at}+${q}`);
        q = piece.e;
      }
      if (q !== b.body.text.length) throw new Error(`pieces end at ${at}+${q}`);
    }
    at += b.body.text.length;
  }
  if (at !== p.src.length) throw new Error(`blocks end at ${at} of ${p.src.length}`);
}
