import { expect, test } from 'vitest';
import { macroDefs } from './macros.ts';
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
