import { expect, test } from 'vitest';
import {
  bblEntries,
  bibEntries,
  bibItems,
  cleanDoi,
  describeEntry,
  logoOf,
  plainText,
} from './bib.ts';
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
    'Nuno Preguiça, Erdős & Schön, pp. 386–400',
  );
});

test('text macros in a field become their text', () => {
  expect(plainText('The {\\TeX}book')).toBe('The TeXbook');
  expect(plainText('\\TeX{} and \\LaTeX, \\LaTeXe, \\BibTeX')).toBe(
    'TeX and LaTeX, LaTeX2e, BibTeX',
  );
  expect(
    plainText("{\\\"u}ber, M\\\"uller, Fran\\c{c}ois, Gro\\ss{}e, \\'{e}t\\'e, \\'{\\i}"),
  ).toBe('über, Müller, François, Große, été, í');
  expect(plainText(String.raw`{\o}re, \aa ngstr{\"o}m, {\l}\'od\'z, \v{S}koda`)).toBe(
    'øre, ångström, łódź, Škoda',
  );
  expect(plainText('Fish \\& Chips,~1--2')).toBe('Fish & Chips, 1–2');
  // An unknown macro keeps its braced text, or goes alone; what follows it stays.
  expect(plainText('\\emph{Deep} \\foo learning \\url{x.org}')).toBe('Deep learning x.org');
  expect(plainText('\\unknown')).toBe('');
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

test('bibitems are read from thebibliography, with their text', () => {
  const src = [
    '\\bibitem{outside} Not in the environment.',
    '\\begin{thebibliography}{99}',
    '\\bibitem{a} A. One.',
    '  \\emph{First}, 2001.',
    '% \\bibitem{commented} Gone.',
    '\\bibitem[Two(2002)]{b} B. Two. Second. 50\\% off. % trailing',
    '\\bibitem [X]{c}C. Three.',
    '\\end{thebibliography}',
    '\\bibitem{after} Not in the environment either.',
  ].join('\n');
  const items = bibItems(src);
  expect(items.map((i) => `${i.key} | ${i.text}`)).toEqual([
    'a | A. One. \\emph{First}, 2001.',
    'b | B. Two. Second. 50\\% off.',
    'c | C. Three.',
  ]);
  for (const i of items) expect(src.slice(i.at, i.at + 8)).toBe('\\bibitem');
  expect(bibItems('\\begin{document}\\cite{a}\\end{document}')).toEqual([]);
  // An environment that never ends runs to the end of the file.
  expect(bibItems('\\begin{thebibliography}{9}\\bibitem{z} Z.').map((i) => i.key)).toEqual(['z']);
});

test('a DOI is read from an entry the way a registry wants it', () => {
  const doi = (fields: Record<string, string>) => cleanDoi({ fields });
  expect(doi({ doi: '10.1007/978-3-540-74958-5\\_1' })).toBe('10.1007/978-3-540-74958-5_1');
  expect(doi({ doi: '{10.1000/a\\%b\\&c\\#d}' })).toBe('10.1000/a%b&c#d');
  for (const written of [
    'doi:10.1000/x',
    'DOI 10.1000/x',
    'DOI: 10.1000/x',
    'https://doi.org/10.1000/x',
    'http://dx.doi.org/10.1000/x',
    '10.1000/x.',
    '10.1000/x,',
    ' 10.1000/x; ',
  ])
    expect(doi({ doi: written })).toBe('10.1000/x');
  // No doi field: a doi.org address in url. Any other address is not a DOI.
  expect(doi({ url: 'https://doi.org/10.1000/x' })).toBe('10.1000/x');
  expect(doi({ url: '\\url{https://dx.doi.org/10.1000/x}' })).toBe('10.1000/x');
  expect(doi({ url: 'https://example.org/10.1000/x' })).toBe('');
  expect(doi({ doi: '10.1000/own', url: 'https://doi.org/10.1000/other' })).toBe('10.1000/own');
  expect(doi({ title: 'T' })).toBe('');
});

test('a command whose name starts with an accent letter is not an accent', () => {
  expect(plainText('a \\textbf{bold} and \\cite{x} but \\c{c}a')).toBe('a bold and x but ça');
});

test('a bibtex .bbl gives its keys, a wrapped natbib label included', () => {
  const plain =
    '\\begin{thebibliography}{1}\n\\bibitem{k} A.~Author. \\newblock {\\em A Book}.\n\\end{thebibliography}\n';
  expect(bblEntries(plain).map((e) => [e.key, e.text])).toEqual([
    ['k', 'A.~Author. \\newblock {\\em A Book}.'],
  ]);
  const natbib =
    '\\begin{thebibliography}{1}\n\\bibitem[Two(2002)]{two}\nB. Two.\n\\bibitem[Long\n  et~al.(2003)]{long} C.\n\\end{thebibliography}\n';
  expect(bblEntries(natbib).map((e) => e.key)).toEqual(['two', 'long']);
});

test('a biblatex .bbl gives each key once, with its title', () => {
  const bbl = [
    '\\refsection{0}',
    '  \\datalist[entry]{nty/global//global/global}',
    '    \\entry{k}{book}{}',
    '      \\name{author}{1}{}{{hash=1}{{un=0}{family={A}}}}',
    '      \\field{title}{A {Book}',
    '        of Things}',
    '    \\endentry',
    '    \\entry{shapiro2011}{inproceedings}{}',
    '      \\field{title}{Conflict-Free Replicated Data Types}',
    '    \\endentry',
    '    \\entry{notitle}{misc}{}',
    '    \\endentry',
    '  \\enddatalist',
    '  \\datalist[entry]{none/global//global/global}',
    '    \\entry{k}{book}{}',
    '      \\field{title}{A Book}',
    '    \\endentry',
    '  \\enddatalist',
    '\\endrefsection',
  ].join('\n');
  expect(bblEntries(bbl).map((e) => [e.key, e.text])).toEqual([
    ['k', 'A {Book} of Things'],
    ['shapiro2011', 'Conflict-Free Replicated Data Types'],
    ['notitle', ''],
  ]);
});

test('a .bbl with no entries gives none', () => {
  expect(bblEntries('')).toEqual([]);
  expect(bblEntries('Just prose, \\cite{k}.')).toEqual([]);
});

test('logos and text commands read as what they print', () => {
  expect(logoOf('\\LaTeX{}')).toBe('LaTeX');
  expect(logoOf('\\LaTeXe')).toBe('LaTeX2e');
  expect(logoOf('\\LaTeX{} x')).toBeNull();
  expect(logoOf('\\foo')).toBeNull();
  expect(plainText('A\\slash B \\copyright{} \\ldots')).toBe('A/B © …');
});
