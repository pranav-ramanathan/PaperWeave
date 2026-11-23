import { expect, test } from 'vitest';
import { DEFAULT_TRANSPARENT } from './parse.ts';
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

test('a list item reads as a bulleted line', () => {
  for (const env of ['itemize', 'enumerate']) {
    const src = `\\begin{document}\n\\section{Aims}\n\nWe aim at two things.\n\n\\begin{${env}}\n\\item A fast parser.\n\\item open-source code.\n\\item\n\\end{${env}}\n\\end{document}\n`;
    const text = read(src);
    expect(text, env).toContain('\n\n• A fast parser.');
    expect(text, env).toContain('\n\n• open-source code.');
    // Only the items print a bullet; a heading does not.
    expect(text.split('•').length - 1, env).toBe(3);
    expect(kindOf(src, 'fast'), env).toBe('text');
    expect(kindOf(src, 'open'), env).toBe('text');
    // The command itself is never prose, so a finding on it is dropped.
    const { segments } = prose(src);
    for (const m of src.matchAll(/\\item/g)) {
      const hits = segments.filter((s) => s.from < m.index + 5 && s.to > m.index);
      expect(
        hits.every((s) => s.kind === 'hard'),
        env,
      ).toBe(true);
    }
  }
});

test('a description list and a list inside an item read as bulleted lines', () => {
  const desc = [
    '\\begin{document}',
    '\\begin{description}',
    '\\item[Parser] reads teh source.',
    '\\item[\\textbf{Speed}] fast',
    '\\end{description}',
    '\\end{document}',
    '',
  ].join('\n');
  const text = read(desc);
  expect(text).toContain('• Parser: reads teh source.');
  expect(text).toContain('• fast');
  expect(kindOf(desc, 'teh')).toBe('text');
  const { segments } = prose(desc);
  const term = desc.indexOf('\\item[Parser]');
  for (const s of segments.filter((s) => s.from < term + 13 && s.to > term))
    expect(s.kind).toBe('hard');
  expect(inProse(segments, desc.indexOf('Parser'), desc.indexOf('Parser') + 6)).toBe(false);

  // A list inside an item, a second paragraph in an item, and options after the environment.
  const nested = [
    '\\begin{document}',
    '\\begin{itemize}',
    '\\item Outerr word',
    '  \\begin{itemize}',
    '  \\item innerr word.',
    '  \\end{itemize}',
    '\\item First para.',
    '',
    '  Secondd para.',
    '\\end{itemize}',
    '\\begin{enumerate}[label=(\\alph*)]',
    '\\item Enumm word.',
    '\\end{enumerate}',
    '\\end{document}',
    '',
  ].join('\n');
  for (const w of ['Outerr', 'innerr', 'Secondd', 'Enumm'])
    expect(kindOf(nested, w), w).toBe('text');
  expect(kindOf(nested, 'label=')).toBe('hard');
  expect(read(nested)).not.toContain('label=');
});

test('code and a formula in an item, and a stray item, are not prose', () => {
  const src = [
    '\\begin{document}',
    '\\begin{description}',
    '\\item[Code] Words here.',
    '\\begin{verbatim}',
    'listingword',
    '\\end{verbatim}',
    '$$ displayword $$',
    '\\end{description}',
    '\\end{document}',
    '',
  ].join('\n');
  expect(kindOf(src, 'listingword')).toBe('hard');
  expect(kindOf(src, 'displayword')).toBe('hard');
  const stray = '\\begin{document}\n\\item[x] Some words.\n\\end{document}\n';
  expect(read(stray)).not.toContain('•');
  // A plain list reads as it did.
  const plain = '\\begin{itemize}\n\\item A one.\n\\item b two.\n\\end{itemize}\n';
  expect(read(plain)).toBe('• A one.\n\n• b two.\n\n ');
});

test("a paper's own words read as the words they print, and are still never changed", () => {
  const macros = { '\\sys': 'PaperWeave', '\\eg': 'e.g. ', '\\db': 'database' };
  const src = 'We built \\sys, \\sys{} and \\sys\\ too; \\eg tools and an \\db.\n';
  const { annotation, segments } = prose(src, DEFAULT_TRANSPARENT, macros);
  expect(annotation).toContainEqual({ markup: '\\sys', interpretAs: 'PaperWeave' });
  expect(annotation).toContainEqual({ markup: '\\sys{}', interpretAs: 'PaperWeave' });
  expect(annotation).toContainEqual({ markup: '\\db', interpretAs: 'database' });
  // The annotation still holds every byte of the source, in order.
  expect(annotation.map((a) => ('text' in a ? a.text : a.markup)).join('')).toBe(src);
  // A space after the macro is the source's own: the one the body ends in is not said twice.
  const said = annotation.map((a) => ('text' in a ? a.text : a.interpretAs)).join('');
  expect(said).toContain('e.g. tools');
  expect(said).not.toContain('e.g.  tools');
  expect(said).toContain('an database.');
  // A finding that touches the macro is dropped, one beside it is kept.
  const at = src.indexOf('\\sys,');
  expect(inProse(segments, at, at + 4)).toBe(false);
  expect(inProse(segments, at - 8, at + 4)).toBe(false);
  expect(inProse(segments, 0, 8)).toBe(true);
  // Without the paper's words the same source reads as before.
  const plain = prose(src);
  expect(plain.annotation).toContainEqual({ markup: '\\sys', interpretAs: 'Dummy' });
  expect(plain.annotation).toContainEqual({ markup: '\\db', interpretAs: 'Item' });
  expect(prose(src, DEFAULT_TRANSPARENT, {})).toEqual(plain);
});

test("a macro that is not one of the paper's words reads as before, whatever the table holds", () => {
  const src = 'See \\two{x}, \\sysx and \\LaTeX{} here.\n';
  const macros = { '\\sys': 'PaperWeave', '\\LaTeX': 'Wrong' };
  expect(prose(src, DEFAULT_TRANSPARENT, macros)).toEqual(prose(src));
});

test('a comment between \\begin{itemize} and the first item is not prose', () => {
  const src =
    '\\begin{document}\n\\begin{itemize}\n%\\item Oldd\n\\item Newword here.\n\\end{itemize}\n\\end{document}\n';
  expect(kindOf(src, 'Oldd')).not.toBe('text');
  expect(kindOf(src, 'Newword')).toBe('text');
  expect(read(src)).not.toContain('Oldd');
});

test('words in an old font group are prose, its braces are not', () => {
  const src = 'A {\\em mispelt} word.';
  expect(kindOf(src, 'mispelt')).toBe('text');
  expect(kindOf(src, '{\\em ')).toBe('hard');
  expect(kindOf(src, '}')).toBe('hard');
  expect(proseIn('A {\\tt code} word.', 'code')).toBe(false);
});

test('a comment in a sentence says nothing', () => {
  expect(read('We show that\n% old claim\nthe result holds.')).toBe(
    'We show that the result holds.\n\n',
  );
  expect(read('We use it. % why\nThen more.')).toBe('We use it. Then more.\n\n');
  expect(read('A long word%\n continues.')).toBe('A long wordcontinues.\n\n');
  const src = 'We show that\n% old claim\nthe result holds.';
  expect(kindOf(src, 'old claim')).toBe('hard');
  expect(proseIn(src, 'old claim')).toBe(false);
  expect(proseIn(src, 'result')).toBe(true);
});
