import { expect, test } from 'vitest';
import { bibEntries, describeEntry, plainText } from './bib.ts';
import { citeIndex } from './labels.ts';
import { fixtureFiles } from './testutil.ts';

const text = (path: string) => Buffer.from(fixtureFiles()[path]).toString();

test('entries are read with their fields, whatever the delimiters', () => {
  const src = [
    'Anything outside an entry is a comment to BibTeX, even @ signs in an e-mail: a@b.c',
    '@string{pldi = "Programming Language Design"}',
    '@comment{ @article{hidden, title = {No} } }',
    '@preamble{ "\\newcommand{\\x}{y}" }',
    '@Article{knuth1984,',
    '  author = {Donald E. Knuth},',
    '  title = "Literate {P}rogramming",',
    '  journal = pldi # " (reprint)",',
    '  year = 1984,',
    '  doi = {10.1093/comjnl/27.2.97},',
    '  year = {1999}',
    '}',
    '',
    '@inproceedings(paren2020, title = {Uses (parentheses) and {nested {braces}}}, author = "A. One and B. Two and C. Three")',
    '@misc{bare}',
    '@book{ spaced:key-1 , title = {A "quoted" title}, }',
    '@article{broken, title = {never closed',
  ].join('\n');
  const entries = bibEntries(src);
  expect(entries.map((e) => [e.type, e.key])).toEqual([
    ['article', 'knuth1984'],
    ['inproceedings', 'paren2020'],
    ['misc', 'bare'],
    ['book', 'spaced:key-1'],
    ['article', 'broken'],
  ]);
  expect(entries[0].fields).toEqual({
    author: 'Donald E. Knuth',
    title: 'Literate {P}rogramming',
    journal: 'pldi (reprint)',
    year: '1984',
    doi: '10.1093/comjnl/27.2.97',
  });
  expect(entries[1].fields.title).toBe('Uses (parentheses) and {nested {braces}}');
  expect(entries[3].fields.title).toBe('A "quoted" title');
  // Offsets name the entry and its key in the file as it is.
  for (const e of entries) {
    expect(src.slice(e.keyAt, e.keyAt + e.key.length)).toBe(e.key);
    expect(src[e.at]).toBe('@');
  }
  expect(src.slice(entries[0].at, entries[0].end)).toMatch(/^@Article\{knuth1984,[\s\S]*\}$/);
});

test('an entry is described the way a person would cite it', () => {
  const [shapiro, , bare] = bibEntries(
    text('article-basic/refs.bib') +
      '\n@misc{bare}\n@book{one, author = {Knuth, Donald E.}, title = {The {\\TeX}book}, year = {1984}}',
  ).filter((e) => ['shapiro2011', 'bare', 'one'].includes(e.key) || e.key === 'nicolaescu2016');
  expect(describeEntry(shapiro)).toBe('Shapiro et al. 2011. Conflict-Free Replicated Data Types');
  expect(describeEntry(bare)).toBe('bare');
  expect(plainText('Nuno Pregui{\\c{c}}a, Erd\\H{o}s \\& Sch\\"{o}n, pp.~386--400')).toBe(
    'Nuno Preguica, Erdos & Schon, pp. 386–400',
  );
});

test('citations are found with their keys, in every common form', () => {
  const src = [
    'As shown~\\cite{a} and \\citep[see][p.~3]{b, c}; \\citet*{d} agrees. % not \\cite{commented}',
    '\\parencite{e}, \\textcite[12]{f}, \\autocite{g}, \\nocite{*}, \\nocite{h}',
    '\\begin{verbatim}\\cite{verbatim}\\end{verbatim} \\citeauthor{i} (\\citeyear{i})',
    '\\newcommand{\\mycite}[1]{\\cite{#1}} \\bibliography{refs}',
  ].join('\n');
  const found = citeIndex(src);
  expect(found.map((c) => `${c.command}:${c.key}`)).toEqual([
    ...['cite:a', 'citep:b', 'citep:c', 'citet:d', 'parencite:e', 'textcite:f', 'autocite:g'],
    ...['nocite:h', 'citeauthor:i', 'citeyear:i'],
  ]);
  for (const c of found) expect(src.slice(c.keyAt, c.keyAt + c.key.length)).toBe(c.key);
  expect(citeIndex(text('ieee-multifile/sections/intro.tex')).map((c) => c.key)).toEqual([
    'knuth1984',
  ]);
});
