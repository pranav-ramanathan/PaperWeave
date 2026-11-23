import { expect, test } from 'vitest';
import {
  findRoot,
  graphicsPaths,
  projectGraphicsPaths,
  includeGraph,
  includes,
  leftOut,
  readyMadeBbls,
} from './graph.ts';
import { labelIndex } from './labels.ts';

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

test('\\import, \\subimport and \\includefrom name a folder and a file in two groups', () => {
  const root = [
    '\\documentclass{article}\\begin{document}',
    '\\import{sections/}{method}',
    '\\subimport{sections}{res}',
    '\\includefrom{}{tail}',
    '\\import{sections/}{gone} % \\import{sections/}{commented}',
    '\\end{document}',
  ].join('\n');
  const files = {
    'main.tex': root,
    'sections/method.tex': 'M',
    'sections/res.tex': 'R',
    'tail.tex': 'T',
  };
  const g = includeGraph(files, 'main.tex');
  expect(g.order).toEqual(['main.tex', 'sections/method.tex', 'sections/res.tex', 'tail.tex']);
  expect(g.edges).toEqual([
    { from: 'main.tex', to: 'sections/method.tex', kind: 'input' },
    { from: 'main.tex', to: 'sections/res.tex', kind: 'input' },
    { from: 'main.tex', to: 'tail.tex', kind: 'input' },
  ]);
  // The missing one is reported where its file name stands.
  expect(g.missing).toEqual([
    { from: 'main.tex', target: 'sections/gone', at: root.indexOf('gone') },
  ]);
  const inc = includes(root).filter((i) => i.import);
  expect(
    inc.map((i) => [i.target, root.slice(i.targetAt, i.targetAt + i.import!.file.length)]),
  ).toEqual([
    ['sections/method', 'method'],
    ['sections/res', 'res'],
    ['tail', 'tail'],
    ['sections/gone', 'gone'],
  ]);
  expect(
    inc.map((i) => root.slice(i.import!.dirAt, i.import!.dirAt + i.import!.dir.length)),
  ).toEqual(['sections/', 'sections', '', 'sections/']);
});

const DOC = (body: string) => `\\documentclass{article}\\begin{document}\n${body}\n\\end{document}`;

test('\\subimport inside an imported file is read from the import folder', () => {
  const files = {
    'main.tex': DOC('\\import{sections/}{intro}'),
    'sections/intro.tex': 'A \\subimport{figs/}{plot}',
    'sections/figs/plot.tex': 'P',
  };
  const g = includeGraph(files, 'main.tex');
  expect(g.order).toEqual(['main.tex', 'sections/intro.tex', 'sections/figs/plot.tex']);
  expect(g.missing).toEqual([]);
});

test('\\input and \\includegraphics in an imported file try the import folder, then the root', () => {
  const files = {
    'main.tex': DOC('\\import{sections}{intro}'),
    'sections/intro.tex':
      '\\input{detail}\\input{rootonly}\\includegraphics{pic}\\includegraphics{rootpic}',
    'sections/detail.tex': 'D',
    'detail.tex': 'not this one',
    'rootonly.tex': 'R',
  };
  const paths = [...Object.keys(files), 'sections/pic.pdf', 'rootpic.png'];
  const g = includeGraph(files, 'main.tex', paths);
  expect(g.missing).toEqual([]);
  expect(g.edges).toEqual([
    { from: 'main.tex', to: 'sections/intro.tex', kind: 'input' },
    { from: 'sections/intro.tex', to: 'sections/detail.tex', kind: 'input' },
    { from: 'sections/intro.tex', to: 'rootonly.tex', kind: 'input' },
    { from: 'sections/intro.tex', to: 'sections/pic.pdf', kind: 'graphics' },
    { from: 'sections/intro.tex', to: 'rootpic.png', kind: 'graphics' },
  ]);
});

test('in an imported file the import folder comes before \\graphicspath', () => {
  const files = {
    'main.tex': '\\graphicspath{{figs/}}' + DOC('\\import{sections/}{intro}'),
    'sections/intro.tex': '\\includegraphics{pic}\\includegraphics{other}',
  };
  const paths = [...Object.keys(files), 'sections/pic.png', 'figs/pic.png', 'figs/other.png'];
  const g = includeGraph(files, 'main.tex', paths);
  expect(g.edges.map((e) => e.to)).toEqual([
    'sections/intro.tex',
    'sections/pic.png',
    'figs/other.png',
  ]);
});

test('a bibliography in an imported file stays relative to the root', () => {
  const files = {
    'main.tex': DOC('\\import{sections/}{intro}'),
    'sections/intro.tex': '\\bibliography{refs}',
    'sections/refs.bib': '',
    'refs.bib': '',
  };
  const g = includeGraph(files, 'main.tex');
  expect(g.edges.map((e) => e.to)).toEqual(['sections/intro.tex', 'refs.bib']);
});

test('two levels of \\subimport add up, and .. folds', () => {
  const files = {
    'main.tex': DOC('\\import{a}{one}'),
    'a/one.tex': '\\subimport{b/}{two}',
    'a/b/two.tex': '\\subimport{c/}{three}\\subimport{../shared/}{x}\\input{local}',
    'a/b/c/three.tex': 'T',
    'a/shared/x.tex': 'X',
    'a/b/local.tex': 'L',
  };
  const g = includeGraph(files, 'main.tex');
  expect(g.missing).toEqual([]);
  expect(g.order).toEqual([
    'main.tex',
    'a/one.tex',
    'a/b/two.tex',
    'a/b/c/three.tex',
    'a/shared/x.tex',
    'a/b/local.tex',
  ]);
});

test('with the root in a folder, the import folder is relative to that folder', () => {
  const files = {
    'root/main.tex': DOC('\\import{sections/}{intro}'),
    'root/sections/intro.tex': '\\subimport{figs/}{plot}\\input{detail}',
    'root/sections/figs/plot.tex': 'P',
    'root/sections/detail.tex': 'D',
  };
  const g = includeGraph(files, 'root/main.tex');
  expect(g.missing).toEqual([]);
  expect(g.order).toEqual([
    'root/main.tex',
    'root/sections/intro.tex',
    'root/sections/figs/plot.tex',
    'root/sections/detail.tex',
  ]);
});

test('a label in a nested subimport is read through the graph order', () => {
  const files: Record<string, string> = {
    'main.tex': DOC('\\import{sections/}{intro}'),
    'sections/intro.tex': '\\subimport{figs/}{plot}',
    'sections/figs/plot.tex': '\\section{S}\\label{sec:nested}',
  };
  const g = includeGraph(files, 'main.tex');
  const keys = g.order.flatMap((p) => labelIndex(files[p]).labels.map((l) => l.key));
  expect(keys).toEqual(['sec:nested']);
});

test('\\import inside an imported file names its folder from the root', () => {
  const files = {
    'main.tex': DOC('\\import{a/}{one}'),
    'a/one.tex': '\\import{b/}{two}',
    'b/two.tex': 'T',
  };
  expect(includeGraph(files, 'main.tex').missing).toEqual([]);
});

test('the sub* forms are flagged', () => {
  const src =
    '\\import{a}{b}\\subimport{a}{b}\\inputfrom{a}{b}\\subinputfrom{a}{b}\\includefrom{a}{b}\\subincludefrom{a}{b}';
  expect(includes(src).map((i) => i.import!.sub)).toEqual([false, true, false, true, false, true]);
});

const PRE = (body: string, pre = '') =>
  `\\documentclass{article}\n${pre}\\begin{document}\n${body}\n`;

test('a \\graphicspath in an \\input preamble file is followed', () => {
  const files = {
    'main.tex': PRE('\\includegraphics{plot}', '\\input{preamble}\n'),
    'preamble.tex': '\\graphicspath{{figures/}}\n',
  };
  const g = includeGraph(files, 'main.tex', [...Object.keys(files), 'figures/plot.pdf']);
  expect(g.edges).toContainEqual({ from: 'main.tex', to: 'figures/plot.pdf', kind: 'graphics' });
  expect(g.missing).toEqual([]);
});

test('a \\graphicspath in a project .sty is followed, relative to the root folder', () => {
  const files = {
    'paper/main.tex': PRE('\\includegraphics{plot}', '\\usepackage{local}\n'),
    'paper/local.sty': '\\graphicspath{{figures/}}\n',
  };
  const g = includeGraph(files, 'paper/main.tex', [
    ...Object.keys(files),
    'paper/figures/plot.pdf',
  ]);
  expect(g.missing).toEqual([]);
  expect(g.edges).toContainEqual({
    from: 'paper/main.tex',
    to: 'paper/figures/plot.pdf',
    kind: 'graphics',
  });
});

test('a later \\graphicspath replaces an earlier one, in TeX order', () => {
  const files = {
    'main.tex': PRE('', '\\graphicspath{{a/}}\n\\input{p}\n\\graphicspath{{c/}}\n'),
    'p.tex': '\\graphicspath{{b/}}\n',
    'late.tex': '\\graphicspath{{z/}}\n',
  };
  expect(projectGraphicsPaths(files, 'main.tex')).toEqual(['c/']);
  const f2 = { ...files, 'main.tex': PRE('', '\\graphicspath{{a/}}\n\\input{p}\n') };
  expect(projectGraphicsPaths(f2, 'main.tex')).toEqual(['b/']);
  // A file read only in the body is not a preamble file.
  const f3 = { ...files, 'main.tex': PRE('\\input{late}', '\\graphicspath{{a/}}\n') };
  expect(projectGraphicsPaths(f3, 'main.tex')).toEqual(['a/']);
});

const BODY = '\\begin{document}\nHi.\n\\end{document}\n';
const CLASS = '\\documentclass{article}\n\\usepackage{amsmath}\n';

test('findRoot follows \\input and \\include in the preamble to the file with \\documentclass', () => {
  const layouts: Record<string, Record<string, string>> = {
    'input{setup}': { 'main.tex': `\\input{setup}\n${BODY}`, 'setup.tex': CLASS },
    'input{setup.tex}': { 'main.tex': `\\input{setup.tex}\n${BODY}`, 'setup.tex': CLASS },
    'input{tex/setup}': { 'main.tex': `\\input{tex/setup}\n${BODY}`, 'tex/setup.tex': CLASS },
    'bare input': { 'main.tex': `\\input setup \n${BODY}`, 'setup.tex': CLASS },
    'include{setup}': { 'main.tex': `\\include{setup}\n${BODY}`, 'setup.tex': CLASS },
    'two levels': {
      'main.tex': `\\input{pre}\n${BODY}`,
      'pre.tex': '\\input{setup}\n',
      'setup.tex': CLASS,
    },
    'setup opens with other preamble commands': {
      'main.tex': `\\input{setup}\n${BODY}`,
      'setup.tex': `\\RequirePackage{fix-cm}\n\\PassOptionsToPackage{svgnames}{xcolor}\n% a comment\n${CLASS}`,
    },
  };
  for (const [name, files] of Object.entries(layouts))
    expect(findRoot(files), name).toBe('main.tex');
});

test('findRoot refuses a class it cannot honestly reach', () => {
  const none: Record<string, Record<string, string>> = {
    dynamic: { 'main.tex': `\\input{\\dir/setup}\n${BODY}`, 'setup.tex': CLASS },
    'after the body': {
      'main.tex': `\\begin{document}\n\\input{setup}\n\\end{document}\n`,
      'setup.tex': CLASS,
    },
    commented: { 'main.tex': `%\\input{setup}\n${BODY}`, 'setup.tex': CLASS },
    cycle: {
      'main.tex': `\\input{a}\n${BODY}`,
      'a.tex': '\\input{b}',
      'b.tex': '\\input{a}',
    },
  };
  for (const [name, files] of Object.entries(none)) expect(findRoot(files), name).toBeNull();
});

test('\\includeonly names are read one by one, and a comment in the list hides nothing else', () => {
  const src =
    '\\includeonly{chapters/intro , % chapters/old, {x}\n  chapters/method.tex,, "chapters/q"}\n\\include{chapters/intro}';
  expect(includes(src).map((i) => [i.kind, i.target])).toEqual([
    ['only', 'chapters/intro'],
    ['only', 'chapters/method.tex'],
    ['only', 'chapters/q'],
    ['input', 'chapters/intro'],
  ]);
  expect(named(src).every((n) => n.split('=')[0] === n.split('=')[1])).toBe(true);
  expect(includes('% \\includeonly{a}')).toEqual([]);
});

test('a file named in \\includeonly is not read in the preamble, and a name there for no file is not missing', () => {
  // Passes without the fix too: it guards against reading \includeonly as an \input.
  const files = {
    'main.tex':
      '\\documentclass{book}\\includeonly{ch/a,ch/gone,\\x}\\begin{document}\\include{ch/a}\\include{ch/b}\\end{document}',
    'ch/a.tex': 'A',
    'ch/b.tex': 'B',
  };
  const g = includeGraph(files, 'main.tex', Object.keys(files));
  expect(g.order).toEqual(['main.tex', 'ch/a.tex', 'ch/b.tex']);
  expect(g.preamble).toEqual([]);
  expect(g.missing).toEqual([]);
  expect(g.dynamic).toEqual([]);
  expect(g.edges.map((e) => e.kind)).toEqual(['input', 'input']);
});

// What an active \includeonly in the root's preamble leaves out of the PDF.
const chapters = '\\include{ch/a}\\include{ch/b}\\include{ch/c}';
const paper = (pre: string, body = chapters) =>
  `\\documentclass{article}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`;
const out = (main: string, more: Record<string, string> = {}, root = 'main.tex') => {
  const files = { [root]: main, ...more };
  return leftOut(files, root, includeGraph(files, root, Object.keys(files)).order);
};

test('an \\includeonly names which chapters the PDF leaves out', () => {
  const main = paper('\\includeonly{ch/a}');
  expect(out(main)).toEqual({ at: main.indexOf('\\includeonly'), names: ['ch/b', 'ch/c'] });
  expect(out(paper('\\includeonly{}'))?.names).toEqual(['ch/a', 'ch/b', 'ch/c']);
});

test('spaces, quotes and .tex do not make a chapter differ from its name', () => {
  const main = paper('\\includeonly{ch/a.tex , "ch/b"}', '\\include{ ch/a}\\include{ch/b.tex}');
  expect(out(main)).toBeNull();
});

test('an \\includeonly that does not count leaves nothing out', () => {
  expect(out(paper('% \\includeonly{ch/a}'))).toBeNull();
  expect(out(paper('', '\\includeonly{ch/a}' + chapters))).toBeNull();
  expect(out(paper('\\includeonly{\\only}'))).toBeNull();
  expect(out(paper('\\includeonly{ch/a}', '\\include{ch/a}'))).toBeNull();
  expect(out(paper('\\includeonly{ch/a}', '\\input{ch/a}'))).toBeNull();
  expect(out(paper(''))).toBeNull();
  expect(out('\\input{x}')).toBeNull();
});

test('the last \\includeonly decides', () => {
  expect(out(paper('\\includeonly{ch/a}\n\\includeonly{ch/a,ch/b,ch/c}'))).toBeNull();
  expect(out(paper('\\includeonly{ch/a,ch/b,ch/c}\n\\includeonly{ch/c}'))?.names).toEqual([
    'ch/a',
    'ch/b',
  ]);
});

test('a chapter included twice is named once; names are compared as plain strings', () => {
  expect(out(paper('\\includeonly{ch/a}', '\\include{ch/b}\\include{ch/b}'))?.names).toEqual([
    'ch/b',
  ]);
  expect(out(paper('\\includeonly{ch/a}', '\\include{./ch/a}'))?.names).toEqual(['./ch/a']);
  expect(out(paper('\\includeonly{ch/a}', '\\include{ch/A}'))?.names).toEqual(['ch/A']);
});

test('a macro in an \\include is skipped, and a root in a folder compares names as written', () => {
  expect(out(paper('\\includeonly{ch/a}', '\\include{\\chap}'))).toBeNull();
  const main = paper('\\includeonly{ch/a}', '\\include{ch/a}\\include{ch/b}');
  expect(out(main, {}, 'paper/main.tex')?.names).toEqual(['ch/b']);
});

test('an \\include in a file the body reads is found; other commands are not \\include', () => {
  const main = paper('\\includeonly{ch/a}', '\\input{ch/body}\\input{ch/b}');
  const more = { 'ch/body.tex': '\\include{ch/c}\n', 'ch/b.tex': 'x', 'ch/c.tex': 'y' };
  expect(out(main, more)?.names).toEqual(['ch/c']);
  expect(
    out(paper('\\includeonly{ch/a}', '\\includegraphics{x}\\includefrom{ch/}{b}\\input{ch/b}')),
  ).toBeNull();
});

test('a subfiles paper that includes only the chapter it names leaves nothing out', () => {
  const main = paper('\\includeonly{sections/discussion}', '\\include{sections/discussion}');
  expect(out(main, { 'sections/discussion.tex': 'x' })).toBeNull();
});

const docOf = (body: string) => `\\documentclass{article}\\begin{document}${body}\\end{document}`;

test('readyMadeBbls: the own .bbl is needed when a named .bib is not in the project', () => {
  const files = { 'main.tex': docOf('\\bibliography{refs,library}') };
  const paths = ['main.tex', 'main.bbl', 'refs.bib'];
  expect(readyMadeBbls(files, 'main.tex', paths)).toEqual([
    { path: 'main.bbl', lacks: ['library'] },
  ]);
  expect(
    readyMadeBbls({ 'main.tex': docOf('\\addbibresource{library.bib}') }, 'main.tex', paths),
  ).toEqual([{ path: 'main.bbl', lacks: ['library.bib'] }]);
});

// Guard: every named .bib is there, so the .bbl is made again.
test('readyMadeBbls: nothing when every named .bib is present or none is named', () => {
  const paths = ['main.tex', 'main.bbl', 'refs.bib'];
  expect(readyMadeBbls({ 'main.tex': docOf('\\bibliography{refs}') }, 'main.tex', paths)).toEqual(
    [],
  );
  expect(readyMadeBbls({ 'main.tex': docOf('x') }, 'main.tex', paths)).toEqual([]);
  expect(readyMadeBbls({ 'main.tex': docOf('% \\bibliography{gone}') }, 'main.tex', paths)).toEqual(
    [],
  );
});

test('readyMadeBbls: a .bbl a file reads by name is needed, wherever it is', () => {
  const files = { 'main.tex': docOf('\\input{main.bbl}') };
  expect(readyMadeBbls(files, 'main.tex', ['main.tex', 'main.bbl', 'old/refs.bib'])).toEqual([
    { path: 'main.bbl', lacks: [] },
  ]);
});

test('readyMadeBbls: a bibliography named by a macro cannot be checked, so the .bbl is needed', () => {
  const files = { 'main.tex': docOf('\\bibliography{\\jobname}') };
  expect(readyMadeBbls(files, 'main.tex', ['main.tex', 'main.bbl'])).toEqual([
    { path: 'main.bbl', lacks: ['\\jobname'] },
  ]);
});

test('readyMadeBbls: a root in a folder looks for the .bib from its own folder', () => {
  const files = { 'src/main.tex': docOf('\\bibliography{refs}') };
  // The .bib is beside another paper, not this root.
  expect(
    readyMadeBbls(files, 'src/main.tex', ['src/main.tex', 'src/main.bbl', 'refs.bib']),
  ).toEqual([{ path: 'src/main.bbl', lacks: ['refs'] }]);
  expect(
    readyMadeBbls(files, 'src/main.tex', ['src/main.tex', 'main.bbl', 'src/refs.bib']),
  ).toEqual([]);
  // Not the root's own .bbl.
  expect(readyMadeBbls(files, 'src/main.tex', ['src/main.tex', 'build/main.bbl'])).toEqual([]);
});
