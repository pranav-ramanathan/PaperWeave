import { expect, test } from 'vitest';
import { macroDefs, mathMacros, textMacroOf, textMacros, textOf } from './macros.ts';
import { fixtureFiles } from './testutil.ts';

test('simple macros are read with their bodies; what the renderer cannot take is left out', () => {
  const src = [
    '\\newcommand{\\R}{\\mathbb{R}}',
    '\\newcommand\\N{\\mathbb{N}}',
    '\\newcommand{\\norm}[1]{\\left\\lVert #1 \\right\\rVert}',
    '\\renewcommand*{\\vec}[1]{\\mathbf{#1}}',
    '\\providecommand{\\set} [2] {\\{ #1 \\mid #2 \\}}',
    '\\newcommand{\\opt}[2][x]{#1 + #2}',
    '\\DeclareMathOperator{\\argmax}{arg\\,max}',
    '\\DeclareMathOperator*{\\esssup}{ess\\,sup}',
    '\\def\\eps{\\varepsilon}',
    '\\def\\pair#1#2{(#1, #2)}',
    '% \\newcommand{\\gone}{x}',
    'Ten \\% of \\newcommand{\\kept}{y}',
    '\\newcommand{\\broken}{never closed',
  ].join('\n');
  expect(macroDefs(src)).toEqual({
    '\\R': '\\mathbb{R}',
    '\\N': '\\mathbb{N}',
    '\\norm': '\\left\\lVert #1 \\right\\rVert',
    '\\vec': '\\mathbf{#1}',
    '\\set': '\\{ #1 \\mid #2 \\}',
    '\\argmax': '\\operatorname{arg\\,max}',
    '\\esssup': '\\operatorname*{ess\\,sup}',
    '\\eps': '\\varepsilon',
    '\\kept': 'y',
  });
});

test("the fixtures' macro files are read", () => {
  const macros = macroDefs(Buffer.from(fixtureFiles()['ieee-multifile/macros.tex']).toString());
  expect(Object.keys(macros)).toEqual(['\\sys', '\\num', '\\todo', '\\xspace', '\\eg']);
  expect(macros['\\num']).toBe('#1');
});

test('macroDefs reads the same definitions whatever else is added to the file', () => {
  const src = [
    '\\newcommand{\\two}[1]{a #1}',
    '\\newcommand{\\opt}[2][x]{#1 + #2}',
    '\\def\\pair#1#2{(#1, #2)}',
    '\\providecommand{\\sys}{PaperWeave}',
    '\\newcommand{\\sys}{Other}',
    '\\DeclareMathOperator{\\tr}{tr}',
  ].join('\n');
  expect(macroDefs(src)).toEqual({
    '\\two': 'a #1',
    '\\sys': 'Other',
    '\\tr': '\\operatorname{tr}',
  });
});

test('a macro whose body is only words reads as those words', () => {
  const defs = {
    '\\sys': 'PaperWeave',
    '\\sysx': '\\sys\\xspace system',
    '\\a': '\\b',
    '\\b': '\\a',
  };
  expect(textOf('PaperWeave', {})).toBe('PaperWeave');
  expect(textOf('e.g.\\ ', {})).toBe('e.g. ');
  expect(textOf('et~al.\\@', {})).toBe('et al.');
  expect(textOf('i.e.,~', {})).toBe('i.e., ');
  expect(textOf('PaperWeave\\xspace', {})).toBe('PaperWeave');
  expect(textOf('\\dots', {})).toBe('…');
  expect(textOf('\\LaTeX{} and \\ss er', {})).toBe('LaTeX and ßer');
  expect(textOf('a\\,b {} c -- d --- e', {})).toBe('a b c – d — e');
  expect(textOf('100\\% \\& R\\_D \\#1 \\$5', {})).toBe('100% & R_D #1 $5');
  expect(textOf('\\sysx', defs)).toBe('PaperWeave system');
  expect(textOf('\\sys{}s', defs)).toBe('PaperWeaves');
  expect(textOf('Café', {})).toBe('Café');
  expect(textOf('a   b\n c', {})).toBe('a b c');
});

test('a body that is more than words is not a word', () => {
  for (const body of [
    'a #1',
    '#1',
    '\\textbf{x}',
    '\\textsc{Splice}\\xspace',
    '\\mathbb{R}',
    '$x$',
    '{x}',
    'a ^ b',
    'a_b',
    'a & b',
    '50 % half',
    '\\operatorname{tr}',
    '\\unknown',
    '',
    '   ',
    '~',
    '\\xspace',
    'x'.repeat(81),
  ])
    expect(textOf(body, {}), body).toBeNull();
  expect(textOf('x'.repeat(80), {})).toBe('x'.repeat(80));
  // A cycle never settles.
  expect(textOf('\\a', { '\\a': '\\b', '\\b': '\\a' })).toBeNull();
  // A macro the paper defines but that is not a word blocks a use of it.
  expect(textOf('\\a', { '\\a': null })).toBeNull();
  expect(textOf('\\dots', { '\\dots': null })).toBeNull();
});

test('a macro is recognised only as itself, or with an empty group', () => {
  const m = { '\\sys': 'PaperWeave' };
  expect(textMacroOf('\\sys', m)).toBe('PaperWeave');
  expect(textMacroOf('\\sys{}', m)).toBe('PaperWeave');
  expect(textMacroOf('\\sys{x}', m)).toBeNull();
  expect(textMacroOf('\\sysx', m)).toBeNull();
  expect(textMacroOf('\\sys ', m)).toBeNull();
  expect(textMacroOf('\\other', m)).toBeNull();
});

const MAIN = (head: string, body = 'Text.') =>
  `\\documentclass{article}\n${head}\n\\begin{document}\n${body}\n\\end{document}\n`;

test('the words a paper defines are those in force, read in the order TeX reads them', () => {
  const files = {
    'main.tex': MAIN(
      [
        '\\usepackage{own}',
        '\\input{defs}',
        '\\renewcommand{\\sys}{Root}',
        '\\newcommand{\\two}[1]{a #1}',
        '\\newcommand{\\opt}[2][x]{#1}',
        '\\DeclareMathOperator{\\tr}{tr}',
        '\\newcommand{\\dots}{etc}',
        '% \\newcommand{\\gone}{Gone}',
        '\\newcommand{\\bold}{\\textbf{x}}',
        '\\newcommand{\\ie}{i.e.~}',
        '\\newcommand{\\etal}{et~al.\\@}',
        '\\newcommand{\\nested}{the \\sys{} system}',
        '\\newcommand{\\xs}{Xs\\xspace}',
        '\\newcommand{\\usexs}{an \\xs system}',
        '\\newcommand{\\viabold}{\\bold}',
      ].join('\n'),
      '\\input{sec}',
    ),
    'defs.tex': '\\newcommand{\\sys}{Defs}\n\\newcommand{\\fromdefs}{From defs}\n',
    'own.sty': '\\newcommand{\\sys}{Sty}\n\\newcommand{\\fromsty}{From sty}\n',
    'sec.tex': 'A section.\n',
    'unread.sty': '\\newcommand{\\neverread}{Never}\n',
  };
  expect(textMacros(files, 'main.tex')).toEqual({
    '\\sys': 'Root',
    '\\fromdefs': 'From defs',
    '\\fromsty': 'From sty',
    '\\ie': 'i.e. ',
    '\\etal': 'et al.',
    '\\nested': 'the Root system',
    '\\xs': 'Xs',
    '\\usexs': 'an Xs system',
  });
});

test('a package read after the root redefines a name only for what follows it', () => {
  const files = {
    'main.tex': MAIN('\\renewcommand{\\sys}{First}\n\\usepackage{own}'),
    'own.sty': '\\renewcommand{\\sys}{Later}\n',
  };
  expect(textMacros(files, 'main.tex')['\\sys']).toBe('Later');
});

test('a name the body of the paper defines otherwise is not a word', () => {
  const files = {
    'main.tex': MAIN(
      '\\newcommand{\\sys}{PaperWeave}\n\\newcommand{\\same}{Same}\n\\newcommand{\\other}{Other}\n\\newcommand{\\uses}{\\sys}',
      '\\renewcommand{\\same}{Same}\n\\renewcommand{\\sys}{Changed}\n\\input{sec}',
    ),
    'sec.tex': '\\renewcommand{\\other}[1]{x}\n',
  };
  expect(textMacros(files, 'main.tex')).toEqual({ '\\same': 'Same' });
});

test('words are found only in a paper with a root, and no more than 256 are kept', () => {
  expect(textMacros({ 'a.tex': '\\newcommand{\\x}{y}' }, 'main.tex')).toEqual({});
  const many = Array.from(
    { length: 300 },
    (_, i) =>
      `\\newcommand{\\w${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10) % 10]}${'uvwxyzabcd'[Math.floor(i / 100)]}}{word}`,
  );
  expect(Object.keys(textMacros({ 'main.tex': MAIN(many.join('\n')) }, 'main.tex')).length).toBe(
    256,
  );
});

const DOC = (preamble: string) =>
  `\\documentclass{article}\n${preamble}\n\\begin{document}\nx\n\\end{document}\n`;

test('mathMacros reads in the order TeX does, from the files and the own packages that are loaded', () => {
  const texts = {
    'main.tex': DOC(
      [
        '\\input{defs}',
        '\\usepackage{own}',
        '\\renewcommand{\\R}{\\mathbb{Q}}',
        '\\usepackage{amsmath}',
      ].join('\n'),
    ),
    'defs.tex': '\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\fromdefs}{d}\n',
    'own.sty': '\\newcommand{\\R}{\\mathbb{Z}}\n\\newcommand{\\fromown}{o}\n',
    'unread.sty': '\\newcommand{\\nope}{n}\n',
  };
  expect(mathMacros(texts, 'main.tex')).toEqual({
    '\\R': '\\mathbb{Q}',
    '\\fromdefs': 'd',
    '\\fromown': 'o',
  });
});

test('a package loaded after the root defines a name wins over the root', () => {
  const texts = {
    'main.tex': DOC('\\renewcommand{\\R}{\\mathbb{Q}}\n\\usepackage{own}'),
    'own.sty': '\\renewcommand{\\R}{\\mathbb{C}}\n',
  };
  expect(mathMacros(texts, 'main.tex')).toEqual({ '\\R': '\\mathbb{C}' });
});

test('providecommand does not override a definition, and is overridden by a later one', () => {
  const after = DOC('\\newcommand{\\R}{A}\n\\providecommand{\\R}{B}');
  expect(mathMacros({ 'main.tex': after }, 'main.tex')).toEqual({ '\\R': 'A' });
  const before = DOC('\\providecommand{\\R}{B}\n\\newcommand{\\R}{A}');
  expect(mathMacros({ 'main.tex': before }, 'main.tex')).toEqual({ '\\R': 'A' });
});

test('an argument the body does not use is dropped, as TeX does', () => {
  const src = DOC(
    [
      '\\newcommand{\\norm}[1]{\\lVert #1\\rVert}',
      '\\newcommand{\\zero}[1]{0}',
      '\\newcommand{\\first}[2]{#1}',
      '\\newcommand{\\both}[2]{#1#2}',
    ].join('\n'),
  );
  expect(mathMacros({ 'main.tex': src }, 'main.tex')).toEqual({
    '\\norm': '\\lVert #1\\rVert',
    '\\zero': '\\@secondoftwo{#1}{0}',
    '\\first': '\\@secondoftwo{#2}{#1}',
    '\\both': '#1#2',
  });
});

test('what the renderer cannot take is left out, and an optional-argument redefinition removes the name', () => {
  const src = DOC(
    [
      '\\newcommand{\\opt}{old}',
      '\\renewcommand{\\opt}[2][x]{#1 + #2}',
      '\\def\\p#1{(#1)}',
      '\\newcommand{\\my@internal}{i}',
      '\\DeclareMathOperator*{\\esssup}{ess\\,sup}',
      '\\newcommand{\\ok}{k}',
    ].join('\n'),
  );
  expect(mathMacros({ 'main.tex': src }, 'main.tex')).toEqual({
    '\\esssup': '\\operatorname*{ess\\,sup}',
    '\\ok': 'k',
  });
});

test('mathMacros has nothing without a root, and a commented begin does not end the preamble', () => {
  expect(mathMacros({ 'a.tex': '\\newcommand{\\x}{1}' }, 'main.tex')).toEqual({});
  const src = [
    '\\documentclass{article}',
    '% \\begin{document}',
    '\\newcommand{\\late}{l}',
    '\\begin{document}',
    '\\newcommand{\\body}{b}',
    '\\end{document}',
  ].join('\n');
  expect(mathMacros({ 'main.tex': src }, 'main.tex')).toEqual({ '\\late': 'l' });
});
