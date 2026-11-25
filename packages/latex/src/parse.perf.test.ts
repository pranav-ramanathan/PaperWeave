// A look-ahead that fails must not be paid for again by the next one: before the parser memoized
// them, each of these was quadratic (or worse) in its size. Each runs a hostile text of about 64 KB
// (16 KB where noted) and must finish well inside the bound. The trees are checked against the
// old parser's in parse.differential.test.ts.
import { expect, test } from 'vitest';
import { parse } from './parse.ts';
import { assertLossless } from './testutil.ts';

const BOUND_MS = 500;
const repeat = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length));

/**
 * [what it hits, the repeated unit, bytes, bound in ms]. The old parser took 0.5 s or more on
 * each of these (several seconds on most; the \lstinline one never finished). Each paragraph that
 * is frozen costs the time of an Error, so the many-paragraph cases are larger with a looser bound.
 */
const CASES: [string, string, number, number?][] = [
  ['a citation option that never closes', '\\cite[', 64_000],
  ['a reference option that never closes', '\\ref[', 64_000],
  ['an option that never closes behind a url', '\\cite[\\url{', 64_000],
  ['an option that never closes behind \\verb', '\\cite[\\verb|', 64_000],
  ['an option that never closes behind \\lstinline (nested look-aheads)', '\\lstinline[', 16_000],
  ['an unclosed brace inside inline math', '${$', 64_000],
  ['an unclosed \\( in font-switch groups', '{\\em \\( } ', 64_000],
  ['a \\) only inside a brace group', '{\\em \\( { \\) } } ', 64_000],
  ['an unclosed \\( in many lists', '\\begin{itemize}\\item \\( \\end{itemize}\n', 64_000],
  ['an environment never closed under many headings', '\\section{a}\n\\begin{x}\n', 96_000],
  ['a brace never closed under many headings', '\\section{a}\n{\n', 64_000],
  ['an unclosed \\[ in many paragraphs', 'x \\[ y\n\n', 128_000, 1000],
  ['a theorem option that never closes', '\\begin{abstract}[', 64_000],
  ['a definition option that never closes', '\\newcommand{\\x}[', 64_000],
];

for (const [what, unit, bytes, bound = BOUND_MS] of CASES) {
  test(`parse is fast on ${what}`, () => {
    const src = repeat(unit, bytes);
    const t = performance.now();
    const p = parse(src);
    const ms = performance.now() - t;
    expect(ms, `${JSON.stringify(unit)} x ${src.length / unit.length}`).toBeLessThan(bound);
    assertLossless(p);
  });
}

test('parse is fast on a hostile paragraph in the middle of a document', () => {
  const para = 'Some words \\cite{a} and $x$ here.';
  const src = `${para}\n\n${repeat('\\cite[', 64_000)}\n\n${para}\n`;
  const t = performance.now();
  const p = parse(src);
  expect(performance.now() - t).toBeLessThan(BOUND_MS);
  assertLossless(p);
  // The ordinary paragraphs on either side are still read as such.
  expect(p.blocks.filter((b) => b.body.kind === 'para' && b.body.text === para)).toHaveLength(2);
});
