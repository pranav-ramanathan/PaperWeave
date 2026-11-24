// The index functions memoize their look-aheads (see scan.ts and the comments at each use).
// `indexes.reference.ts` has them as they were before, copied unchanged (but for the one loop that
// never ended, which is cut off there too, see its header); every answer must be deeply equal to
// the old one, on every fixture and on seeded random text built from the tokens they care about.
import { isDeepStrictEqual } from 'node:util';
import { expect, test } from 'vitest';
import { bblEntries, bibItems } from './bib.ts';
import { argumentsOf, floatParts } from './floats.ts';
import { decodeFile } from './index.ts';
import { includeGraph, includes } from './graph.ts';
import { citeIndex, labelIndex } from './labels.ts';
import { mathMacros, textMacros } from './macros.ts';
import { proseEnvs } from './envs.ts';
import { declaredSpelling } from './spelling.ts';
import * as old from './indexes.reference.ts';
import { finder, groupEnds } from './scan.ts';
import { fixtureFiles, rng, type Rng } from './testutil.ts';

/** Random texts per function (every one is at least 2000). */
const N = Number(process.env.DIFF ?? 3000);

const COMMON = [
  ...['{', '}', '[', ']', '(', ')', '<', '>', '%', '\n', '\n\n', ' ', '\t', ',', '\\\\', '\\%'],
  ...['\\{', '\\}', '\\', '*', '=', '#1', '|', '!', '$', 'word', 'two words', 'a', 'b', 'x'],
  ...['\\begin{x}', '\\end{x}', '\\begin{verbatim}', '\\end{verbatim}', '\\begin{document}'],
  ...['\\begin{lstlisting}', '\\end{lstlisting}', '\\begin{minted}', '\\end{minted}'],
  ...['\\begin{Verbatim*}', '\\end{Verbatim*}', '\\begin{verbatim*}', '\\end{verbatim*}'],
];
/** Whole commands, so that the matching paths run as well as the failing ones. */
const WHOLE = [
  ...['\\label{a}', '\\ref{a,b}', '\\cite[p. 3]{k}', '\\cites(pre)[a][b]{k}[c][d]{m}', '\\ref{a}'],
  ...[
    '\\hyperref[key]{text}',
    '\\crefrange{a}{b}',
    '\\lstinline[x]|y|',
    '\\url{a%b}',
    '\\verb|x}|',
  ],
  ...['\\begin{lstlisting}[label=lst:a]', '\\lstinputlisting[label={lst:b},caption=x]{f}', 'x}'],
  ...['\\input{a}', '\\includegraphics[width=1cm]{fig}', '\\addplot table[x=a]{data}'],
  ...['\\addplot[blue] table {data}', '\\inputminted[x]{c}{a}', '\\usepackage[x]{b}', '{ a }'],
  ...['\\import{sub/}{d}', '\\documentclass[a4]{c}', '\\graphicspath{{a/}{b/}}', '\\input a'],
  ...['\\newtheorem{foo}{Foo}', '\\declaretheorem[x]{bar}', '\\newmdtheoremenv[x]{baz}{Baz}'],
  ...['\\newcommand{\\a}{x}', '\\newcommand{\\b}[1]{#1}', '\\def\\c{z}', '\\renewcommand{\\a}{y}'],
  ...['\\DeclareMathOperator*{\\op}{op}', '\\newcommand{\\d}[2][x]{y}', '\\providecommand{\\e}{w}'],
  ...['\\begin{thebibliography}{9}', '\\bibitem[x]{k} text', '\\bibitem{m} t', '\\bibitem [l] {n}'],
  ...['\\entry{k}{t}{}', '\\field{title}{T}', '\\endentry', '\\field{title} { Two {B} }'],
  ...['\\usepackage[british]{babel}', '\\documentclass[american]{article}', '\\usepackage[uk]{x}'],
  ...['\\caption[short]{long}', '\\caption*{x}', '\\caption{a {b} c}', '\\subcaption[s]{t}'],
  ...['\\includegraphics[width=1cm,alt={A b}]{fig}', '\\includegraphics[alt=Bare text,x]{f}'],
  ...['\\begin{tabular}{lcr}', 'a & b \\\\', 'c & d \\\\[2pt]', '\\hline', '\\end{tabular}'],
  ...['\\begin{tabularx}{\\textwidth}{lX}', '\\toprule', '\\multicolumn{2}{c}{x}', '\\cline{1-2}'],
];
const LABELS = [
  ...WHOLE,
  ...['\\label{', '\\ref{', '\\eqref{', '\\cref{', '\\crefrange{', '\\hyperref[', '\\autoref['],
  ...['\\cite{', '\\citep[', '\\cite<', '\\citet*[x][y]{', '\\nocite{', '\\cites{', '\\cites('],
  ...['\\parencites(', '\\autocites[', '\\textcites{', '\\cite[', '\\ref[', '\\label[', '\\url{'],
  ...[
    '\\verb|',
    '\\verb*!',
    '\\verb',
    '\\lstinline[',
    '\\lstinline{',
    '\\lstinline|',
    '\\mintinline{',
  ],
  ...['\\href{', '\\nolinkurl{', '\\lstinputlisting[', '\\lstinputlisting{', 'label=', 'label={'],
  ...['\\begin{lstlisting}[', '\\begin{lstlisting}[label=', 'caption=', '\\label', 'fig:', 'eq:a'],
  ...['key', 'k1,k2', ', ', '*', '\\ref', '\\cite', ']{', '}{', '}[', ')(', ')[', '>{', ']['],
];
const INCLUDES = [
  ...WHOLE,
  ...['\\input{', '\\input ', '\\include{', '\\includeonly{', '\\includegraphics[', '\\subfile{'],
  ...[
    '\\includegraphics{',
    '\\includegraphics*[',
    '\\bibliography{',
    '\\addbibresource[',
    '\\input[',
  ],
  ...['\\usepackage[', '\\usepackage{', '\\RequirePackage{', '\\documentclass[', '\\LoadClass{'],
  ...['\\documentclass{', '\\bibliographystyle{', '\\lstinputlisting[', '\\verbatiminput{'],
  ...['\\inputminted[', '\\inputminted{', '\\addplot[', '\\addplot3+', '\\addplot table[', 'table'],
  ...['table{', '\\import{', '\\subimport*{', '\\includefrom{', '\\graphicspath{', '{a/}', '{b/}'],
  ...['\\includesvg{', '\\includepdf[', '\\csvreader[', '\\inputfoo{', '\\includegraphicsx[', '"'],
  ...['a', 'b', 'c', 'a.tex', 'sub/d', 'fig', 'fig.pdf', 'refs', 'a,b', ' c ', '../a', './b', '#1'],
  ...[
    '\\newtheorem{',
    '\\newtheorem*{',
    '\\declaretheorem[',
    '\\declaretheorem{',
    'foo',
    'bar,baz',
  ],
  ...['\\newmdtheoremenv[', '\\newmdtheoremenv{', '\\spnewtheorem{', 'lemma', 'Foo}{Foo', '}{'],
];
const MACROS = [
  ...WHOLE,
  ...[
    '\\newcommand{',
    '\\newcommand',
    '\\renewcommand*{',
    '\\providecommand{',
    '\\def',
    '\\def\\a',
  ],
  ...['\\DeclareMathOperator*{', '\\DeclareMathOperator{', '\\a', '\\b', '\\x', '\\a{}', '{\\a}'],
  ...['[1]', '[2]', '[0]', '[1][', '[x]', '[ 3 ]', '#1', '#2', '\\xspace', '~', '--', '\\LaTeX'],
  ...[
    '\\input{a}',
    '\\usepackage{b}',
    '\\documentclass{c}',
    '\\begin{document}',
    '\\end{document}',
  ],
  ...['\\input{sub/d}', '\\include{a}', 'Word', 'two words', '\\ ', '\\,', '\\%', '\\{', '\\}'],
];
const BIB = [
  ...WHOLE,
  ...[
    '\\begin{thebibliography}',
    '\\end{thebibliography}',
    '\\bibitem[',
    '\\bibitem{',
    '\\bibitem',
  ],
  ...[
    '\\bibitem [x] {',
    '\\entry{',
    '\\endentry',
    '\\field{title}{',
    '\\field{title} {',
    '\\field{',
  ],
  ...['\\field{author}{', '}{', '{}', 'key', 'Title words', '\\newblock', 'a=b', '%\n'],
];
const FLOATS = [
  ...WHOLE,
  ...['\\caption{', '\\caption*[', '\\caption[', '\\subcaption{', '\\caption', '\\footnote{'],
  ...[
    '\\includegraphics[',
    '\\includegraphics{',
    '\\includegraphics*[',
    'alt=',
    'alt={',
    ', alt = ',
  ],
  ...[
    '\\begin{tabular}{',
    '\\begin{tabular}[',
    '\\begin{tabularx}{',
    '\\end{tabular}',
    '\\end{tabularx}',
  ],
  ...[
    'lcr',
    'p{2cm}',
    '@{}',
    '&',
    '\\\\',
    '\\\\[',
    '\\\\*',
    '\\hline',
    '\\toprule',
    '\\cline{',
    '\\multicolumn{',
  ],
  ...[
    '\\begin{figure}',
    '\\end{figure}',
    '\\begin{table}',
    '\\end{table}',
    '\\centering',
    '\\label{',
  ],
];
const SPELL = [
  ...WHOLE,
  ...[
    '\\usepackage[',
    '\\usepackage{',
    '\\RequirePackage[',
    '\\documentclass[',
    '\\documentclass{',
  ],
  ...[
    '\\PassOptionsToPackage{',
    '\\PassOptionsToPackage[',
    '\\setmainlanguage[',
    '\\setdefaultlanguage{',
  ],
  ...['babel', 'british', 'american', 'uk', 'us', 'main=', 'variant=', 'english', 'article'],
  ...['\\usepackage[british]{babel}', '\\usepackage[main=american,british]{babel}'],
];

const tokens = (r: Rng, vocab: string[], n: number) =>
  Array.from({ length: n }, () => r.pick(r.int(3) === 0 ? COMMON : vocab)).join(
    r.int(4) === 0 ? ' ' : '',
  );

/** Many of one opener, then a few closers: the shape of the hostile texts. */
function repeated(r: Rng, vocab: string[]) {
  const closers = [
    '}',
    ']',
    ')',
    '>',
    '\n',
    '%\n',
    '\\end{x}',
    '\\end{verbatim}',
    '|',
    '{a}',
    '[a]',
  ];
  const parts: string[] = [];
  for (let k = 1 + r.int(4); k > 0; k--) {
    parts.push(r.pick(vocab).repeat(1 + r.int(25)));
    parts.push(tokens(r, vocab, r.int(6)));
    parts.push(r.pick(closers).repeat(r.int(4)));
  }
  return parts.join(r.int(2) ? '' : ' ');
}

/** The k-th text for a vocabulary: short, long, or many of one opener. */
function text(seed: number, vocab: string[]) {
  const r = rng(seed);
  return seed % 5 === 4
    ? repeated(r, vocab)
    : tokens(r, vocab, 1 + r.int(seed % 5 === 3 ? 120 : 30));
}

/** Throws, naming `what` (with the seed), unless the new answer deeply equals the old one. */
function same(what: string, input: unknown, a: unknown, b: unknown) {
  if (!isDeepStrictEqual(a, b))
    throw new Error(
      `${what}: answers differ\nnew ${JSON.stringify(a)}\nold ${JSON.stringify(b)}\ninput ${JSON.stringify(input)}`,
    );
}

/** A small project from random texts: a root, and the files its tokens name. */
function project(seed: number, vocab: string[]): Record<string, string> {
  const r = rng(seed);
  const files: Record<string, string> = {};
  for (const path of ['main.tex', 'a.tex', 'b.sty', 'c.cls', 'sub/d.tex', 'refs.bib'])
    if (path === 'main.tex' || r.int(3) > 0)
      files[path] =
        seed % 5 === 4 ? repeated(r, vocab) : tokens(r, vocab, 1 + r.int(seed % 5 === 3 ? 80 : 25));
  return files;
}

const FUNCTIONS: [string, string[], (src: string) => [unknown, unknown]][] = [
  ['labelIndex', LABELS, (s) => [labelIndex(s), old.labelIndex(s)]],
  ['citeIndex', LABELS, (s) => [citeIndex(s), old.citeIndex(s)]],
  ['includes', INCLUDES, (s) => [includes(s), old.includes(s)]],
  ['bibItems', BIB, (s) => [bibItems(s), old.bibItems(s)]],
  ['bblEntries', BIB, (s) => [bblEntries(s), old.bblEntries(s)]],
  ['declaredSpelling', SPELL, (s) => [declaredSpelling(s), old.declaredSpelling(s)]],
  ['floatParts', FLOATS, (s) => floatsOf(`\\begin{${s.length % 2 ? 'figure' : 'table'}}${s}`)],
  ['argumentsOf', FLOATS, (s) => [argumentsOf(s, CAPTION), old.argumentsOf(s, CAPTION)]],
];
const CAPTION = /\\(?:sub)?caption\*?(?![a-zA-Z])/g;
function floatsOf(s: string): [unknown, unknown] {
  return [floatParts(s), old.floatParts(s)];
}
for (const [name, vocab, run] of FUNCTIONS) {
  test(`${name} gives the old answer on random text`, () => {
    for (let seed = 0; seed < N; seed++) {
      const src = text(seed + 7_000_000, vocab);
      const [a, b] = run(src);
      same(`${name} seed ${seed + 7_000_000}`, src, a, b);
    }
  });
}

type Files = Record<string, string>;
const PROJECTS: [string, string[], (f: Files, root: string) => [unknown, unknown]][] = [
  ['includeGraph', INCLUDES, (f, r) => [includeGraph(f, r), old.includeGraph(f, r)]],
  ['proseEnvs', INCLUDES, (f, r) => [proseEnvs(f, r), old.proseEnvs(f, r)]],
  ['mathMacros', MACROS, (f, r) => [mathMacros(f, r), old.mathMacros(f, r)]],
  ['textMacros', MACROS, (f, r) => [textMacros(f, r), old.textMacros(f, r)]],
];
for (const [name, vocab, run] of PROJECTS) {
  test(`${name} gives the old answer on random projects`, () => {
    for (let seed = 0; seed < N; seed++) {
      const files = project(seed + 8_000_000, [...vocab, ...MACROS.slice(0, 6)]);
      const [a, b] = run(files, 'main.tex');
      same(`${name} seed ${seed + 8_000_000}`, files, a, b);
    }
  });
}

/** The scans of scan.ts, asked in any order, against the plain ones they stand for. */
test('the memoized scans answer as the plain scans do, asked in any order', () => {
  const plainGroup = (
    s: string,
    at: number,
    escapes: boolean,
    comments: boolean,
    open: string,
    close: string,
  ) => {
    let depth = 0;
    for (let i = at; i < s.length; i++) {
      if (escapes && s[i] === '\\') i++;
      else if (comments && s[i] === '%') while (i < s.length && s[i] !== '\n') i++;
      else if (s[i] === open) depth++;
      else if (s[i] === close && --depth === 0) return i + 1;
    }
    return -1;
  };
  const KINDS: [boolean, boolean, string, string][] = [
    [false, false, '{', '}'],
    [true, false, '{', '}'],
    [true, true, '{', '}'],
    [true, true, '[', ']'],
  ];
  const pieces = [
    '{',
    '}',
    '{',
    '}',
    '[',
    ']',
    '\\',
    '\\{',
    '\\}',
    '\\]',
    'x',
    ' ',
    '%',
    '\n',
    'ab',
  ];
  for (let seed = 0; seed < N; seed++) {
    const r = rng(9_000_000 + seed);
    const s = tokens(r, pieces, 1 + r.int(60));
    for (const [escapes, comments, open, close] of KINDS) {
      const ends = groupEnds(s, { escapes, comments, open, close });
      const opens = [...s.matchAll(open === '{' ? /\{/g : /\[/g)].map((m) => m.index);
      for (let k = opens.length; k > 0; k--) {
        const at = opens.splice(r.int(k), 1)[0];
        same(
          `groupEnds seed ${9_000_000 + seed}`,
          [s, at, escapes, comments, open],
          ends(at),
          plainGroup(s, at, escapes, comments, open, close),
        );
      }
    }
    const find = finder(s);
    for (let k = 0; k < 20; k++) {
      const needle = r.pick(['}', ']', '\n', '{', '\\end', 'ab']);
      const from = r.int(s.length + 2);
      same(
        `finder seed ${9_000_000 + seed}`,
        [s, needle, from],
        find(needle, from),
        s.indexOf(needle, from),
      );
    }
  }
});

test('every fixture gets the old answers', () => {
  const projects = new Map<string, Record<string, string>>();
  let files = 0;
  for (const [path, bytes] of Object.entries(fixtureFiles())) {
    const d = decodeFile(bytes);
    if (!d.editable) continue;
    const [dir, ...rest] = path.split('/');
    const own = rest.join('/');
    if (!own) continue;
    projects.set(dir, { ...projects.get(dir), [own]: d.text });
    files++;
    for (const [name, , run] of FUNCTIONS) {
      const [a, b] = run(d.text);
      same(`${name} on ${path}`, path, a, b);
    }
  }
  expect(files).toBeGreaterThan(20);
  expect(projects.size).toBeGreaterThan(5);
  for (const [dir, f] of projects) {
    const root = 'main.tex' in f ? 'main.tex' : Object.keys(f)[0];
    for (const [name, , run] of PROJECTS) {
      const [a, b] = run(f, root);
      same(`${name} on ${dir}`, dir, a, b);
    }
  }
});
