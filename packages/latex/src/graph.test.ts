import { expect, test } from 'vitest';
import { graphicsPaths, includeGraph, includes } from './graph.ts';

test('\\graphicspath folders are read, and a comment hides them', () => {
  expect(graphicsPaths('\\graphicspath{{a/}{b/c/}}')).toEqual(['a/', 'b/c/']);
  expect(graphicsPaths('\\graphicspath{ {figs/} }')).toEqual(['figs/']);
  expect(graphicsPaths('% \\graphicspath{{a/}}\nx')).toEqual([]);
  expect(graphicsPaths('\\begin{document}')).toEqual([]);
});

test('a picture found through \\graphicspath is not missing', () => {
  const root = '\\graphicspath{{figures/}}\\includegraphics{plot}\\includegraphics{gone}';
  const g = includeGraph({ 'main.tex': root }, 'main.tex', ['main.tex', 'figures/plot.png']);
  expect(g.edges).toContainEqual({ from: 'main.tex', to: 'figures/plot.png', kind: 'graphics' });
  expect(g.missing.map((m) => m.target)).toEqual(['gone']);
});

/** What `includes` reads from `src`, as `target@text-at-offset`. */
const named = (src: string) =>
  includes(src).map((i) => `${i.target}=${src.slice(i.targetAt, i.targetAt + i.target.length)}`);

test('styles, classes, listings, PDFs and data files are read as support files', () => {
  const read = (src: string) => includes(src).map((i) => [i.kind, i.target, i.ext]);
  expect(read('\\usepackage[a=b]{mystyle, other}')).toEqual([
    ['support', 'mystyle', '.sty'],
    ['support', 'other', '.sty'],
  ]);
  expect(read('\\RequirePackage{s/mine}')).toEqual([['support', 's/mine', '.sty']]);
  expect(read('\\documentclass[11pt]{myclass}\\LoadClass{base}')).toEqual([
    ['support', 'myclass', '.cls'],
    ['support', 'base', '.cls'],
  ]);
  expect(read('\\bibliographystyle{plain2}')).toEqual([['support', 'plain2', '.bst']]);
  for (const src of [
    '\\lstinputlisting[language=C]{code/a.txt}',
    '\\verbatiminput{code/a.txt}',
    '\\inputminted[linenos]{python}{code/a.txt}',
    '\\includepdf[pages=1]{code/a.txt}',
    '\\pgfplotstableread{code/a.txt}',
    '\\csvreader[head=false]{code/a.txt}{}{}',
    '\\csvautotabular{code/a.txt}',
    '\\addplot table {code/a.txt};',
    '\\addplot+[red] table[x=a,y=b] {code/a.txt};',
    '\\addplot3 table[col sep=comma]{code/a.txt};',
  ])
    expect(named(src), src).toEqual(['code/a.txt=code/a.txt']);
});

test('a package of the system is not missing, and a support file is not walked into', () => {
  const root = [
    '\\documentclass{article}\\usepackage{amsmath,mystyle}\\usepackage{\\x}',
    '\\csvautotabular{gone.csv}\\begin{document}\\input{a}\\end{document}',
  ].join('\n');
  const files = { 'main.tex': root, 'a.tex': 'A', 'mystyle.sty': '\\input{b}' };
  const g = includeGraph(files, 'main.tex', Object.keys(files));
  expect(g.missing).toEqual([]);
  expect(g.dynamic).toEqual([]);
  expect(g.order).toEqual(['main.tex', 'a.tex']);
  expect(g.preamble).toEqual([]);
  expect(g.edges).toEqual([
    { from: 'main.tex', to: 'mystyle.sty', kind: 'support' },
    { from: 'main.tex', to: 'a.tex', kind: 'input' },
  ]);
});

test('quotes, a space before the brace, and a name without braces are read', () => {
  expect(named('\\includegraphics{"my plot"}')).toEqual(['my plot=my plot']);
  expect(named('\\input {sections/intro}')).toEqual(['sections/intro=sections/intro']);
  expect(named('\\input sections/intro\n')).toEqual(['sections/intro=sections/intro']);
  expect(named('\\input\\foo \\input{a}')).toEqual(['a=a']);
});

test('verbatim bodies are not read, and \\\\% is a comment', () => {
  for (const env of ['verbatim', 'Verbatim', 'lstlisting', 'minted'])
    expect(includes(`\\begin{${env}}\n\\input{a}\n\\end{${env}}\\input{b}`)).toHaveLength(1);
  expect(named('x \\\\% \\input{a}\n\\input{b}')).toEqual(['b=b']);
  expect(named('50\\% \\input{a}')).toEqual(['a=a']);
  expect(named('\\\\\\% \\input{a}')).toEqual(['a=a']);
});
