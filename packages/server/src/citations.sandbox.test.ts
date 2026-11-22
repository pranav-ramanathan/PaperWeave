// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { citationReport } from './citations.ts';
import { exportZip, importZip } from './import.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let outsider: { id: string };

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  outsider = await t.signIn('outsider@example.org');
});
afterAll(() => t.close());

// Odd on purpose: a byte order mark, CRLF line ends, tabs, trailing spaces, text between
// entries. Reading it must not disturb any of that.
const REFS =
  '\ufeff% My references\r\n\r\n@Article{knuth1984,\r\n\tauthor = {Donald E. Knuth},  \r\n\ttitle  = "Literate {P}rogramming",\r\n\tyear   = 1984,\r\n\tdoi    = {https://doi.org/10.1093/comjnl/27.2.97}\r\n}\r\n\r\nstray text\r\n@book{lamport1994, title = {LaTeX}, author = {Leslie Lamport}, year = {1994}}\r\n@misc{knuth1984, title = {The same key again}}\r\n';
const MORE =
  '@inproceedings{shapiro2011,\n  title = {CRDTs},\n  author = {Shapiro, Marc and Pregui{\\c{c}}a, Nuno and Baquero, Carlos}\n}\n@misc{never, title = {Cited only by a file left out}}\n';
const FILES = {
  'main.tex': [
    '\\documentclass{article}',
    '\\begin{document}',
    'As \\citep{knuth1984} and \\citep[p.~2]{lamport1994, nobody2020} say. % \\cite{commented}',
    '\\input{body}',
    '\\bibliography{refs,more}',
    '\\end{document}',
    '',
  ].join('\n'),
  'body.tex': 'Also \\citet{shapiro2011}, \\cite{ghost} and \\nocite{lamport1994}.\n',
  'unused.tex': 'Not part of the paper: \\cite{never}.\n',
  'refs.bib': REFS,
  'more.bib': MORE,
};

test('entries, missing keys and duplicate keys are found, and the .bib files are untouched', async () => {
  const zip = await writeZip(
    Object.entries(FILES).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Citations');
  const report = await citationReport(t.pool, store, owner.id, project.id);
  expect(
    report.entries.map((e) => `${e.path}:${e.line} ${e.key} | ${e.description} | ${e.doi}`),
  ).toEqual([
    'more.bib:1 shapiro2011 | Shapiro et al. CRDTs | null',
    'more.bib:5 never | Cited only by a file left out | null',
    'refs.bib:3 knuth1984 | Knuth 1984. Literate Programming | 10.1093/comjnl/27.2.97',
    'refs.bib:11 lamport1994 | Lamport 1994. LaTeX | null',
    'refs.bib:12 knuth1984 | The same key again | null',
  ]);
  // Which of them the paper names. Both entries under a key twice used count: either may be
  // the one BibTeX keeps. A citation in a file the paper does not include is not the paper's.
  expect(report.entries.filter((e) => !e.cited).map((e) => e.key)).toEqual(['never']);
  expect(report.missing.map((m) => `${m.path}:${m.line} ${m.command} ${m.key}`)).toEqual([
    'main.tex:3 citep nobody2020',
    'body.tex:1 cite ghost',
  ]);
  expect(report.duplicates).toEqual([
    {
      key: 'knuth1984',
      places: [
        { fileId: expect.any(String), path: 'refs.bib', line: 3 },
        { fileId: expect.any(String), path: 'refs.bib', line: 12 },
      ],
    },
  ]);
  // The paper mostly uses \citep, so that is what an inserted citation should use.
  expect(report.command).toBe('citep');

  // Reading the bibliography changed nothing: every file comes back byte for byte.
  const back = await readZip(await exportZip(t.pool, store, owner.id, project.id));
  for (const [path, text] of Object.entries(FILES))
    expect(
      Buffer.from(back.entries.find((e) => e.path === path)!.bytes).equals(Buffer.from(text)),
      path,
    ).toBe(true);

  await expect(citationReport(t.pool, store, outsider.id, project.id)).rejects.toMatchObject({
    code: 'not_found',
  });
});

test('\\bibitem entries are entries: known keys with a place and a one-line description', async () => {
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    'See \\cite{one}, \\cite{two} and \\cite{ghost}.',
    '\\begin{thebibliography}{9}',
    '\\bibitem{one} A. One.',
    '  First, 2001.',
    '\\bibitem[Two(2002)]{two} B. Two. Second.',
    '\\end{thebibliography}',
    '\\end{document}',
    '',
  ].join('\n');
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(main) }]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Bibitems');
  const report = await citationReport(t.pool, store, owner.id, project.id);
  expect(
    report.entries.map(
      (e) => `${e.path}:${e.line} ${e.type} ${e.key} | ${e.description} | ${e.cited}`,
    ),
  ).toEqual([
    'main.tex:5 bibitem one | A. One. First, 2001. | true',
    'main.tex:7 bibitem two | B. Two. Second. | true',
  ]);
  expect(report.missing.map((m) => m.key)).toEqual(['ghost']);
  expect(report.duplicates).toEqual([]);
});

// A paper that came with its .bbl and no .bib: the .bbl is its bibliography.
const BBL_BIBTEX =
  '\\begin{thebibliography}{2}\n\n\\bibitem[One(2001)]{k}\nA.~One.\n\\newblock {\\em First}, 2001.\n\n\\bibitem[Two(2002)]{two}\nB.~Two.\n\\newblock Second, 2002.\n\n\\end{thebibliography}\n';
const BBL_BIBLATEX = [
  '\\refsection{0}',
  '  \\datalist[entry]{nty/global//global/global}',
  '    \\entry{k}{book}{}',
  '      \\field{title}{A Book}',
  '    \\endentry',
  '    \\entry{two}{book}{}',
  '      \\field{title}{Another}',
  '    \\endentry',
  '  \\enddatalist',
  '\\endrefsection',
  '',
].join('\n');
const MAIN = (cites: string) =>
  `\\documentclass{article}\n\\begin{document}\n${cites}\n\\bibliography{refs}\n\\end{document}\n`;
const importFiles = async (files: Record<string, string>, name: string) => {
  const zip = await writeZip(
    Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  return (await importZip(t.pool, store, owner.id, zip, name))[0];
};

test('a paper with a .bbl and no .bib has the .bbl for its bibliography', async () => {
  const project = await importFiles(
    { 'main.tex': MAIN('\\cite{k}, \\cite{two} and \\cite{ghost}.'), 'main.bbl': BBL_BIBTEX },
    'Bbl only',
  );
  const report = await citationReport(t.pool, store, owner.id, project.id);
  expect(report.entries.map((e) => `${e.path}:${e.line} ${e.type} ${e.key} | ${e.cited}`)).toEqual([
    'main.bbl:3 bibitem k | true',
    'main.bbl:7 bibitem two | true',
  ]);
  expect(report.entries[0].description).toContain('First');
  expect(report.missing.map((m) => m.key)).toEqual(['ghost']);
  expect(report.duplicates).toEqual([]);
});

test('a biblatex .bbl does the same', async () => {
  const project = await importFiles(
    { 'main.tex': MAIN('\\cite{k} and \\cite{two}.'), 'main.bbl': BBL_BIBLATEX },
    'Biblatex bbl',
  );
  const report = await citationReport(t.pool, store, owner.id, project.id);
  expect(report.entries.map((e) => `${e.key} | ${e.description}`)).toEqual([
    'k | A Book',
    'two | Another',
  ]);
  expect(report.missing).toEqual([]);
});

test("only the root's own .bbl is read, wherever the root is", async () => {
  const project = await importFiles(
    {
      'src/main.tex': MAIN('\\cite{k} and \\cite{stray}.'),
      'src/main.bbl': BBL_BIBTEX,
      'old.bbl': BBL_BIBTEX.replace('{k}', '{stray}'),
    },
    'Folder root',
  );
  const report = await citationReport(t.pool, store, owner.id, project.id);
  expect(report.missing.map((m) => m.key)).toEqual(['stray']);
});

// Guard: passes without the .bbl being read, and must go on passing with it.
test('an inline thebibliography wins over a .bbl with the same keys, with no duplicates', async () => {
  const main = MAIN('\\cite{k}.').replace(
    '\\bibliography{refs}',
    '\\begin{thebibliography}{1}\n\\bibitem{k} Inline.\n\\end{thebibliography}',
  );
  const project = await importFiles({ 'main.tex': main, 'main.bbl': BBL_BIBTEX }, 'Inline and bbl');
  const report = await citationReport(t.pool, store, owner.id, project.id);
  expect(report.entries.filter((e) => e.key === 'k').map((e) => e.path)).toEqual(['main.tex']);
  expect(report.duplicates).toEqual([]);
});

// Guard, as above.
test('a .bbl is ignored when the paper has a .bib', async () => {
  const project = await importFiles(
    { 'main.tex': MAIN('\\cite{k} and \\cite{extra}.'), 'refs.bib': '@misc{k, title={T}}\n' },
    'Bib then bbl',
  );
  // The import would drop the .bbl, and a new file cannot be named .bbl: put the row in directly.
  const bytes = Buffer.from(BBL_BIBTEX.replace('{two}', '{extra}'));
  await t.pool.query(
    "insert into files (project_id, path, digest, size, readonly_reason) values ($1, 'main.bbl', $2, $3, 'build output')",
    [project.id, await store.put(bytes), bytes.length],
  );
  const report = await citationReport(t.pool, store, owner.id, project.id);
  expect(report.missing.map((m) => m.key)).toEqual(['extra']);
  expect(report.duplicates).toEqual([]);
});
