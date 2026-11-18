import { expect, test } from 'vitest';
import { auxLabels, labelIndex } from './labels.ts';
import { fixtureFiles } from './testutil.ts';

const text = (path: string) => Buffer.from(fixtureFiles()[path]).toString();

test('labels and references are found where they are, and nowhere else', () => {
  const src = [
    '\\section{One}\\label{sec:one}',
    'See \\ref{sec:one}, \\eqref{eq:a} and \\cref{fig:x, tab:y}. % not \\ref{commented}',
    'A percent sign: 50\\% of \\ref{sec:two}.',
    '\\begin{verbatim}',
    '\\label{in:verbatim} \\ref{in:verbatim}',
    '\\end{verbatim}',
    '\\verb|\\ref{in:verb}| and \\Cref[x]{thm:z} and \\crefrange{eq:a}{eq:b}',
    '\\newcommand{\\fig}[1]{\\label{fig:#1}}',
    '\\label{sec:two}\\labelwidth \\refstepcounter{x}',
  ].join('\n');
  const { labels, refs } = labelIndex(src);
  expect(labels.map((l) => l.key)).toEqual(['sec:one', 'sec:two']);
  expect(refs.map((r) => `${r.command}:${r.key}`)).toEqual([
    ...['ref:sec:one', 'eqref:eq:a', 'cref:fig:x', 'cref:tab:y', 'ref:sec:two'],
    ...['Cref:thm:z', 'crefrange:eq:a', 'crefrange:eq:b'],
  ]);
  // Offsets point at the key itself and at the whole command.
  for (const x of [...labels, ...refs]) {
    expect(src.slice(x.keyAt, x.keyAt + x.key.length)).toBe(x.key);
    expect(src.slice(x.at, x.end)).toMatch(/^\\[a-zA-Z]+(\[x\])?(\{[^}]*\})+$/);
  }
});

test('the fixtures have the labels and references we expect', () => {
  const method = labelIndex(text('ieee-multifile/sections/method.tex'));
  expect(method.labels.map((l) => l.key)).toEqual(['sec:method', 'eq:commute', 'eq:minimal']);
  expect(method.refs.map((r) => r.key)).toEqual(['eq:commute', 'eq:minimal']);
  const ams = labelIndex(text('ams-multifile/sections/main-result.tex'));
  expect(ams.labels.map((l) => l.key)).toEqual(['sec:main', 'lem:commute', 'thm:main']);
  expect(ams.refs.map((r) => r.key)).toEqual(['lem:commute', 'def:splice']);
});

test('numbers are read from an .aux file as LaTeX wrote them', () => {
  const aux = [
    '\\relax',
    '\\newlabel{sec:intro}{{1}{1}}',
    '\\newlabel{sec:method}{{II}{2}{Design}{section.2}{}}',
    '\\newlabel{sub:a}{{\\mbox  {II-A}}{2}}',
    '\\newlabel{eq:commute}{{2.1}{3}}',
    '\\newlabel{eq:commute@cref}{{[equation][1][2]2.1}{[1][3][]3}}',
    '\\newlabel{tab:x}{{\\caption@xref {tab:x}{ on input line 4}}{4}}',
    '\\@writefile{toc}{\\contentsline {section}{\\numberline {1}Intro}{1}{}}',
    '\\newlabel{broken}{{1',
  ].join('\n');
  expect(auxLabels(aux)).toEqual({
    'sec:intro': { number: '1', page: '1' },
    'sec:method': { number: 'II', page: '2' },
    'sub:a': { number: 'II-A', page: '2' },
    'eq:commute': { number: '2.1', page: '3' },
    'tab:x': { number: 'tab:x on input line 4', page: '4' },
  });
});
