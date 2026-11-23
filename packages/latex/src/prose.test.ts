import { expect, test } from 'vitest';
import { inProse, prose, readAs } from './prose.ts';
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

/** Whether any character of `words` in `src` is prose. */
const proseIn = (src: string, words: string) => {
  const at = src.indexOf(words);
  return prose(src).segments.some(
    (s) => s.kind === 'text' && s.from < at + words.length && s.to > at,
  );
};

test('a biblatex multicite is one citation, to its last group', () => {
  const src = 'We agree \\autocites[see][12]{a}[adn compare][15]{b} on this.';
  expect(proseIn(src, 'adn')).toBe(false);
  expect(inProse(prose(src).segments, src.indexOf('adn'), src.indexOf('adn') + 3)).toBe(false);
  expect(proseIn(src, '\\autocites[see][12]{a}[adn compare][15]{b}')).toBe(false);
  expect(kindOf(src, 'We agree')).toBe('text');
  expect(kindOf(src, 'on this')).toBe('text');
});

test('a multicite with global notes in parentheses has no prose inside', () => {
  const src = 'Yes \\parencites(global adn)(post)[a][b]{x}[c][d]{y} indeed.';
  expect(proseIn(src, '\\parencites(global adn)(post)[a][b]{x}[c][d]{y}')).toBe(false);
  expect(kindOf(src, 'indeed')).toBe('text');
});

test('whitespace between a citation command and its arguments is part of the citation', () => {
  const src = 'See \\cite [p] {k} here.';
  expect(proseIn(src, '\\cite [p] {k}')).toBe(false);
  expect(kindOf(src, 'See')).toBe('text');
  expect(kindOf(src, 'here')).toBe('text');
});

test('an angle-bracket note of a citation is not prose', () => {
  const src = 'See \\cite<adn>{k} here.';
  expect(proseIn(src, '\\cite<adn>{k}')).toBe(false);
  expect(kindOf(src, 'here')).toBe('text');
});

test('a plain citation with a note and the text around it read as before', () => {
  const src = 'Known work \\cite[p. 3]{k} says so.';
  expect(proseIn(src, '\\cite[p. 3]{k}')).toBe(false);
  expect(kindOf(src, 'Known work')).toBe('text');
  expect(kindOf(src, 'says so')).toBe('text');
  expect(read(src).trim()).toBe('Known work [1] says so.');
});

test('a TeX accent reads as its character, and is prose', () => {
  const src = "We met at the Caf\\'e.";
  const { annotation, segments } = prose(src);
  expect(annotation).toContainEqual({ markup: "\\'e", interpretAs: '\u00e9' });
  const at = src.indexOf('Caf');
  expect(inProse(segments, at, at + 6)).toBe(true);
});

test('a stretch reads as the checker read it', () => {
  const src = "By Kov\\'a\\v{c} here.\nthe\nthe 50\\% of";
  const { segments } = prose(src);
  const at = (w: string) => src.indexOf(w);
  const name = at('Kov');
  expect(readAs(src, segments, name, at(' here'))).toBe('Kov\u00e1\u010d');
  expect(segments.find((s) => s.from === at("\\'a"))).toMatchObject({ kind: 'soft', as: '\u00e1' });
  expect(readAs(src, segments, at('50'), at('50') + 7)).toBe('50% of');
  // Part of one piece of text.
  expect(readAs(src, segments, at('here') + 1, at('here') + 4)).toBe('ere');
  // A line break is read as a space.
  expect(readAs(src, segments, at('the\nthe'), at('the\nthe') + 7)).toBe('the the');
});

test('text commands read as what they print', () => {
  const src = 'We ran 5\\,km, and so on \\ldots and more, in \\LaTeX{} and \\TeX\\ too.';
  expect(read(src)).toContain('5\u2009km, and so on \u2026and more, in LaTeX and TeX too.');
  expect(kindOf(src, '\\ldots')).toBe('soft');
  expect(kindOf(src, '\\,')).toBe('soft');
  expect(kindOf(src, '\\LaTeX')).toBe('hard');
});

test('a national letter followed by a space does not split the word', () => {
  const src = 'See Vo\\ss ler here.\n';
  const { segments } = prose(src);
  const at = src.indexOf('Vo');
  const to = src.indexOf(' here');
  expect(inProse(segments, at, to)).toBe(true);
  expect(readAs(src, segments, at, to)).toBe('Voßler');
});
