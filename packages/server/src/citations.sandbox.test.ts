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
