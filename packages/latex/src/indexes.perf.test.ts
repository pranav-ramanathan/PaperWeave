// A look-ahead that fails must not be paid for again by the next opener: before the indexes
// memoized them, each of these was quadratic in its size (a scan to the end of the text, restarted
// at every token). Each runs a hostile text of about 300 KB and must finish well inside the bound.
// The answers are checked against the old functions in indexes.differential.test.ts.
import { expect, test } from 'vitest';
import { bblEntries, bibItems } from './bib.ts';
import { proseEnvs } from './envs.ts';
import { argumentsOf, floatParts } from './floats.ts';
import { includeGraph, includes } from './graph.ts';
import { citeIndex, labelIndex } from './labels.ts';
import { mathMacros, textMacros } from './macros.ts';
import { declaredSpelling } from './spelling.ts';

const BOUND_MS = 500;
const BYTES = 300_000;
const repeat = (unit: string, bytes = BYTES) => unit.repeat(Math.ceil(bytes / unit.length));

/** [function, what it hits, the repeated unit]. */
const CASES: [string, string, string][] = [
  ['labelIndex', 'a label that never closes', '\\label{'],
  ['labelIndex', 'a reference that never closes', '\\ref{a,'],
  ['labelIndex', 'an option that never closes', '\\ref['],
  ['labelIndex', 'a hyperref option that never closes', '\\hyperref['],
  ['labelIndex', 'a multicite note that never closes', '\\autocites('],
  ['labelIndex', 'an angle note that never closes', '\\cite<'],
  ['labelIndex', 'an address that never closes', '\\url{'],
  ['labelIndex', 'a listing option that never closes', '\\lstinputlisting['],
  ['labelIndex', 'a listing with an option that never closes', '\\begin{lstlisting}['],
  ['labelIndex', 'a verbatim argument that never closes', '\\lstinline{'],
  ['citeIndex', 'a citation that never closes', '\\cite{'],
  ['citeIndex', 'a multicite that never closes', '\\cites{'],
  ['includeGraph', 'a picture option that never closes', '\\includegraphics['],
  ['includeGraph', 'an input option that never closes', '\\input['],
  ['includeGraph', 'a package option that never closes', '\\usepackage['],
  ['includeGraph', 'a table option that never closes', '\\addplot[ table['],
  ['includeGraph', 'a minted option that never closes', '\\inputminted['],
  ['includeGraph', 'verbatim text that never ends', '\\begin{verbatim}'],
  ['proseEnvs', 'a picture option that never closes', '\\includegraphics['],
  ['proseEnvs', 'a theorem option that never closes', '\\declaretheorem['],
  ['proseEnvs', 'a theorem option that never closes (mdframed)', '\\newmdtheoremenv['],
  ['proseEnvs', 'verbatim text that never ends', '\\begin{lstlisting}'],
  ['mathMacros', 'a definition body that never closes', '\\newcommand{\\a}{'],
  ['mathMacros', 'a definition option that never closes', '\\newcommand{\\a}['],
  ['mathMacros', 'a \\def body that never closes', '\\def\\a{'],
  ['mathMacros', 'an operator that never closes', '\\DeclareMathOperator{\\a}{'],
  ['textMacros', 'a definition body that never closes', '\\newcommand{\\a}{'],
  ['bibItems', 'an item option that never closes', '\\begin{thebibliography}{9}\\bibitem['],
  ['bblEntries', 'entries with no end', '\\entry{a}{b}'],
  ['declaredSpelling', 'a package option that never closes', '\\usepackage['],
  ['includes', 'a support option that never closes', '\\documentclass['],
  ['argumentsOf', 'a caption that never closes', '\\caption{'],
  ['argumentsOf', 'a caption option that never closes', '\\caption['],
  ['floatParts', 'a caption option that never closes', '\\caption['],
  ['floatParts', 'a picture option that never closes', '\\includegraphics['],
  ['floatParts', 'a picture group that never closes', '\\includegraphics{'],
  ['floatParts', 'a table specification that never closes', '\\begin{tabular}{'],
];

/** What a function is asked, and what it answers (checked below to be the empty answer). */
const RUN: Record<string, (src: string) => unknown> = {
  labelIndex: (s) => labelIndex(s),
  citeIndex: (s) => citeIndex(s),
  includes: (s) => includes(s),
  includeGraph: (s) => includeGraph({ 'main.tex': s }, 'main.tex'),
  proseEnvs: (s) => proseEnvs({ 'main.tex': s }, 'main.tex'),
  mathMacros: (s) => mathMacros({ 'main.tex': s }, 'main.tex'),
  textMacros: (s) => textMacros({ 'main.tex': s }, 'main.tex'),
  bibItems: (s) => bibItems(s),
  bblEntries: (s) => bblEntries(s),
  declaredSpelling: (s) => declaredSpelling(s),
  argumentsOf: (s) => argumentsOf(s, /\\(?:sub)?caption\*?(?![a-zA-Z])/g),
  floatParts: (s) => floatParts(`\\begin{figure}${s}\\end{figure}`),
};

for (const [fn, what, unit] of CASES) {
  test(`${fn} is fast on ${what}`, () => {
    const src = repeat(unit);
    const t = performance.now();
    RUN[fn](src);
    const ms = performance.now() - t;
    expect(ms, `${fn} on ${JSON.stringify(unit)} x ${src.length / unit.length}`).toBeLessThan(
      BOUND_MS,
    );
  });
}

test('hostile text does not hide the real ones around it', () => {
  const hostile = repeat('\\label{', 100_000);
  const src = `\\label{a} \\ref{a} \\cite{k}\n${hostile}\n\\label{b} \\ref{b}`;
  const t = performance.now();
  const { labels, refs } = labelIndex(src);
  expect(performance.now() - t).toBeLessThan(BOUND_MS);
  // The first unclosed `\label{` closes at the brace of `\label{b}`, with `\label{` in its key:
  // that is no key, and nothing up to its brace is read (as before); what follows it is.
  expect(labels.map((l) => l.key)).toEqual(['a']);
  expect(refs.map((r) => r.key)).toEqual(['a', 'b']);
  expect(citeIndex(src).map((c) => c.key)).toEqual(['k']);
});

test('an unclosed multicite ends', () => {
  // It used to ask the same question for ever.
  for (const src of ['\\cites{a', 'x \\cites{a, b\n\n', '\\autocites[x]{a', '\\cites{a} {b']) {
    expect(() => citeIndex(src)).not.toThrow();
  }
  expect(citeIndex('\\cites{a}{b}{c').map((c) => c.key)).toEqual(['a', 'b']);
});
