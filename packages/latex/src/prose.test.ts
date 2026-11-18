import { expect, test } from 'vitest';
import { inProse, prose } from './prose.ts';
import { fixtureFiles } from './testutil.ts';

// The fixtures that are UTF-8 LaTeX, as text.
const texts = Object.fromEntries(
  Object.entries(fixtureFiles())
    .filter(([path]) => path.endsWith('.tex') && !path.startsWith('encodings/'))
    .map(([path, bytes]) => [path, Buffer.from(bytes).toString('utf8')]),
);

/** The source as a checker reads it: prose as it is, everything else as its stand-in. */
const read = (src: string) =>
  prose(src)
    .annotation.map((a) => ('text' in a ? a.text : a.interpretAs))
    .join('');
/** What kind of thing each word of interest is. */
const kindOf = (src: string, word: string) => {
  const at = src.indexOf(word);
  const { segments } = prose(src);
  return segments.find((s) => s.from <= at && at < s.to)!.kind;
};

test('every character of every fixture is in the annotation, in order', () => {
  expect(Object.keys(texts).length).toBeGreaterThan(8);
  for (const [path, src] of Object.entries(texts)) {
    const { annotation, segments } = prose(src);
    expect(annotation.map((a) => ('text' in a ? a.text : a.markup)).join(''), path).toBe(src);
    // The segments tile the source: a finding's place is always in exactly one of them.
    let at = 0;
    for (const s of segments) {
      expect(s.from, path).toBe(at);
      expect(s.to, path).toBeGreaterThan(s.from);
      at = s.to;
    }
    expect(at, path).toBe(src.length);
  }
});

test('a sentence with LaTeX in it still reads as a sentence', () => {
  const src =
    '\\begin{document}\nWe call it \\emph{fast}, see~\\cite{knuth} and\nSection~\\ref{sec:a}, for an $n$-gram and a $k$-mer at 5\\% loss.\n\\end{document}\n';
  expect(read(src)).toContain(
    'We call it fast, see\u00a0[1] and Section\u00a01, for an Item-gram and a Dummy-mer at 5% loss.',
  );
  // A formula set apart is part of the sentence around it.
  const display =
    '\\begin{document}\nThe mean is\n\\[ x = 1 \\]\nwhere $x$ is small.\n\\end{document}\n';
  expect(read(display).replace(/\s+/g, ' ')).toContain('The mean is Dummy where Dummy is small.');
});

test('only running text is prose; code, keys, formulas and commands are never to be changed', () => {
  const src = [
    '\\documentclass{article}',
    '\\newcommand{\\sys}{Weave}',
    '\\begin{document}',
    '\\section{Results}',
    'Plain words, \\emph{stressed} words, \\texttt{code words}, \\cite{keyword} and $mathword$.',
    '% a commentword',
    '\\begin{verbatim}',
    'listingword',
    '\\end{verbatim}',
    '\\begin{itemize}',
    '  \\item itemword \\url{http://addressword}',
    '\\end{itemize}',
    '\\end{document}',
    '',
  ].join('\n');
  for (const word of ['Results', 'Plain', 'stressed', 'itemword'])
    expect(kindOf(src, word), word).toBe('text');
  for (const word of [
    'documentclass',
    'Weave',
    'code words',
    'keyword',
    'mathword',
    'commentword',
    'listingword',
    'addressword',
  ])
    expect(kindOf(src, word), word).toBe('hard');

  const { segments } = prose(src);
  const range = (words: string) => [src.indexOf(words), src.indexOf(words) + words.length] as const;
  expect(inProse(segments, ...range('Plain words'))).toBe(true);
  // Across the command that opens the emphasis: not all prose.
  expect(inProse(segments, ...range('\\emph{stressed'))).toBe(false);
  expect(inProse(segments, ...range('code words'))).toBe(false);
  expect(inProse(segments, ...range('words, \\cite{keyword}'))).toBe(false);
  // Across a line break inside a paragraph is fine: a word repeated over the break is a find.
  const broken = '\\begin{document}\nthe\nthe end\n\\end{document}\n';
  expect(
    inProse(prose(broken).segments, broken.indexOf('the'), broken.indexOf('the end') + 3),
  ).toBe(true);
  // A line break alone is not prose.
  expect(
    inProse(prose(broken).segments, broken.indexOf('the') + 3, broken.indexOf('the') + 4),
  ).toBe(false);
});
