// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { importZip, listFiles } from './import.ts';
import { labelReport } from './labels.ts';
import { editFile } from './sync.ts';
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

test('labels are listed file by file, with references that miss and names used twice', async () => {
  const zip = await writeZip(
    Object.entries({
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\input{sections/b}',
        '\\input{sections/a}',
        'See \\ref{sec:a}, \\ref{sec:nowhere} and \\eqref{eq:one}.',
        '\\end{document}',
        '',
      ].join('\n'),
      'sections/a.tex':
        '\\section{A}\\label{sec:a}\n\\begin{equation}x\\label{eq:one}\\end{equation}\n',
      'sections/b.tex':
        '\\section{B}\\label{sec:b}\nAs in \\cref{sec:a,sec:gone}.\n\\label{eq:one}\n',
      // Not included by anything: its labels are not part of the paper.
      'old/draft.tex': '\\label{sec:a}\\ref{sec:never}\n',
    }).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Labels');
  const report = await labelReport(t.pool, store, owner.id, project.id);
  expect(report.labels.map((l) => `${l.path}:${l.line} ${l.key}`)).toEqual([
    'sections/b.tex:1 sec:b',
    'sections/b.tex:3 eq:one',
    'sections/a.tex:1 sec:a',
    'sections/a.tex:2 eq:one',
  ]);
  expect(report.undefined.map((r) => `${r.path}:${r.line} ${r.command} ${r.key}`)).toEqual([
    'main.tex:5 ref sec:nowhere',
    'sections/b.tex:2 cref sec:gone',
  ]);
  expect(report.duplicates.map((d) => [d.key, d.places.map((p) => p.path)])).toEqual([
    ['eq:one', ['sections/b.tex', 'sections/a.tex']],
  ]);

  // It follows the text as it is now, not as it was uploaded.
  const files = await listFiles(t.pool, owner.id, project.id);
  const main = files.find((f) => f.path === 'main.tex')!;
  await editFile(t.pool, store, main.id, owner.id, (text) => {
    const at = text.toString().indexOf('See ');
    text.insert(at, '\\label{sec:nowhere}\n');
  });
  const now = await labelReport(t.pool, store, owner.id, project.id);
  expect(now.undefined.map((r) => r.key)).toEqual(['sec:gone']);
  expect(now.labels[0]).toMatchObject({ key: 'sec:nowhere', path: 'main.tex', line: 5 });

  await expect(labelReport(t.pool, store, outsider.id, project.id)).rejects.toMatchObject({
    code: 'not_found',
  });
});
