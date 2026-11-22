// Needs the services in infra/compose.yaml and the toolchain image. Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptInvitation,
  approveDataset,
  blobStore,
  datasetProposal,
  editFile,
  exportRevision,
  heldDataReadBy,
  heldInRevisions,
  heldNow,
  heldReadMessage,
  importZip,
  invite,
  listFiles,
  readZip,
  requestBuild,
  restoreRevision,
  saveChart,
  saveRevision,
  submissionChecks,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { FIXTURES, fixtureFiles } from '../../../packages/latex/src/testutil.ts';
import { buildNext, imageId } from './builder.ts';
import { drawNext } from './charts.ts';

const store = blobStore(TEST_ENV);
const image = imageId();
let t: Awaited<ReturnType<typeof testDb>>;
const users = {} as Record<'owner' | 'viewer' | 'outsider', { id: string; email: string }>;

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
});
afterAll(() => t.close());

const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\begin{document}',
  'See Figure~\\ref{fig:gone} and \\cite{nobody}.',
  '\\includegraphics{figures/absent}',
  '\\input{sections/\\which}',
  '\\PackageWarning{journal}{Use the final option}',
  '\\begin{figure}[t]',
  '  \\includegraphics[width=4cm]{charts/latency}',
  '  \\caption{Latency.}\\label{fig:latency}',
  '\\end{figure}',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');
const BIB = '@book{knuth, author = {Donald Knuth}, title = {The TeXbook}, year = 1984}\n';
const CSV = 'day,latency (ms)\n2024-03-01,9\n2024-03-02,38\n';
const COLUMNS = [
  { name: 'day', type: 'date', unit: '' },
  { name: 'latency (ms)', type: 'number', unit: 'ms' },
];

test('the checks before submitting find what is wrong, and give the files once nothing is', async () => {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: 'refs.bib', bytes: Buffer.from(BIB) },
    { path: 'data/latency.csv', bytes: Buffer.from(CSV) },
  ]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Submit');
  const { token } = await invite(t.pool, users.owner.id, project.id, users.viewer.email, 'viewer');
  await acceptInvitation(t.pool, users.viewer.id, token);
  const ids = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  const approve = async () =>
    approveDataset(t.pool, store, users.owner.id, project.id, ids['data/latency.csv'], {
      version: (
        await datasetProposal(t.pool, store, users.owner.id, project.id, ids['data/latency.csv'])
      ).version,
      columns: COLUMNS,
      missing: [],
    });
  const chart = { kind: 'line', x: 'day', y: 'latency (ms)' };
  const replace = (path: string, from: string, to: string) =>
    editFile(t.pool, store, ids[path], users.owner.id, (text) => {
      const at = text.toString().indexOf(from);
      if (at < 0) throw new Error(`${from} is not in ${path}`);
      text.delete(at, from.length);
      text.insert(at, to);
    });
  const checks = () => submissionChecks(t.pool, store, users.viewer.id, project.id);
  const build = async () => {
    await requestBuild(t.pool, users.owner.id, project.id);
    expect(await buildNext(t.pool, store, image)).toBe(true);
  };

  // A chart is drawn, and then its data changes.
  await approve();
  const chartId = await saveChart(t.pool, store, users.owner.id, project.id, {
    ...chart,
    name: 'latency',
    dataset: ids['data/latency.csv'],
  });
  expect(await drawNext(t.pool, store, image)).toBe(true);
  await replace('data/latency.csv', '38\n', '38\n2024-03-03,41\n');

  const first = await checks();
  expect(first).toMatchObject({ ready: false, revisionId: null, building: false });
  const main = { fileId: ids['main.tex'], path: 'main.tex' };
  expect(first.findings).toEqual([
    {
      level: 'problem',
      kind: 'file',
      message: 'The paper has no file "figures/absent".',
      ...main,
      line: 5,
    },
    {
      level: 'warning',
      kind: 'file',
      message: '"sections/\\which" is put together by a macro, so it could not be checked.',
      ...main,
    },
    {
      level: 'problem',
      kind: 'label',
      message: '\\ref{fig:gone} refers to a label the paper does not have.',
      ...main,
      line: 4,
    },
    {
      level: 'problem',
      kind: 'citation',
      message: '\\cite{nobody} cites a key no bibliography entry has.',
      ...main,
      line: 4,
    },
    {
      level: 'problem',
      kind: 'chart',
      message: 'The chart "latency" is out of date: its data has changed.',
      chartId,
    },
    { level: 'problem', kind: 'build', message: 'The paper has not been built yet.' },
  ]);

  // Built as it is, the compiler's own errors are among the problems.
  await build();
  const failed = (await checks()).findings.filter((f) => f.kind === 'compiler');
  expect(failed.some((f) => f.level === 'problem')).toBe(true);

  // Everything is put right, except that nothing has been built since.
  await replace('main.tex', '\\ref{fig:gone}', '\\ref{fig:latency}');
  await replace('main.tex', '\\cite{nobody}', '\\cite{knuth}');
  await replace('main.tex', '\\includegraphics{figures/absent}\n', '');
  await replace('main.tex', '\\input{sections/\\which}\n', '');
  await approve();
  await saveChart(t.pool, store, users.owner.id, project.id, { ...chart, id: chartId });
  const waiting = await checks();
  expect(waiting.findings.filter((f) => f.level === 'problem').map((f) => f.message)).toEqual(
    expect.arrayContaining([
      'The chart "latency" is waiting to be drawn.',
      'The paper has changed since it was last built.',
    ]),
  );
  expect(await drawNext(t.pool, store, image)).toBe(true);
  await requestBuild(t.pool, users.owner.id, project.id);
  expect(await checks()).toMatchObject({ ready: false, building: true });
  // Nothing builds it for five minutes. The page that shows these checks looks again by
  // itself while a build is on its way; it must not go on doing that for ever.
  // (Every build of the paper is moved back together, so that this one is still the newest.)
  await t.pool.query(
    "update builds set created_at = created_at - interval '5 minutes' where project_id = $1",
    [project.id],
  );
  const stuck = await checks();
  expect(stuck).toMatchObject({ ready: false, building: false });
  expect(stuck.findings.filter((f) => f.kind === 'build').map((f) => f.message)).toEqual([
    'A build of the paper has been waiting for more than two minutes. The build service may be busy or not running.',
  ]);
  expect(await buildNext(t.pool, store, image)).toBe(true);

  // Ready: what is left is for the author to weigh, and the revision is the one that was built.
  const ready = await checks();
  expect(ready.findings.filter((f) => f.level === 'problem')).toEqual([]);
  expect(ready).toMatchObject({ ready: true, building: false });
  expect(ready.findings).toContainEqual(
    expect.objectContaining({
      level: 'warning',
      kind: 'compiler',
      message: expect.stringContaining('Use the final option'),
    }),
  );
  const built = (
    await t.pool.query(
      'select revision_id from builds where project_id = $1 order by created_at desc limit 1',
      [project.id],
    )
  ).rows[0].revision_id;
  expect(ready.revisionId).toBe(built);

  // One more keystroke, and the build is no longer of the paper as it stands.
  await replace('main.tex', 'See Figure', 'See also Figure');
  expect(await checks()).toMatchObject({ ready: false, revisionId: null });

  // A chart the paper does not show is nobody's problem.
  await replace('main.tex', '  \\includegraphics[width=4cm]{charts/latency}\n', '');
  await replace('data/latency.csv', '41\n', '41\n2024-03-04,44\n');
  expect((await checks()).findings.filter((f) => f.kind === 'chart')).toEqual([]);

  expect(
    await submissionChecks(t.pool, store, users.outsider.id, project.id).then(
      () => 'ok',
      (e) => e.code,
    ),
  ).toBe('not_found');
}, 240_000);

// Real builds of papers whose verdict used to be wrong. TeX's own account of a build decides what
// reading the paper cannot: a bibliography written by hand, a file or label from a package.
const doc = (pre: string, body: string, cls = 'article') =>
  `\\documentclass{${cls}}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`;
const BIBK = '@book{k, author={A One}, title={First}, year=2001, publisher={P}}\n';
const THEBIB =
  '\\begin{thebibliography}{9}\n\\bibitem{a} A. One. First. 2001.\n\\bibitem[Two(2002)]{b} B. Two. Second. 2002.\n\\end{thebibliography}';

/** Import a paper, build it as it is, and say what the checks make of it. */
async function verdict(name: string, files: Record<string, string | Buffer>) {
  const zip = await writeZip(
    Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, users.owner.id, zip, name);
  await requestBuild(t.pool, users.owner.id, project.id);
  expect(await buildNext(t.pool, store, image, 90)).toBe(true);
  const found = await submissionChecks(t.pool, store, users.owner.id, project.id);
  const problems = found.findings.filter((f) => f.level === 'problem');
  return { ...found, problems, text: problems.map((f) => `${f.kind}: ${f.message}`) };
}

test('a paper whose chart was put back to an older drawing of its data is not ready', async () => {
  const main =
    '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\includegraphics{charts/latency}\n\\end{document}\n';
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(main) },
    { path: 'data/latency.csv', bytes: Buffer.from(CSV) },
  ]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Restored chart');
  const csv = (await listFiles(t.pool, users.owner.id, project.id)).find((f) =>
    f.path.endsWith('.csv'),
  )!.id;
  const approve = async () =>
    approveDataset(t.pool, store, users.owner.id, project.id, csv, {
      version: (await datasetProposal(t.pool, store, users.owner.id, project.id, csv)).version,
      columns: COLUMNS,
      missing: [],
    });
  const spec = { kind: 'line', x: 'day', y: 'latency (ms)', name: 'latency', dataset: csv };
  await approve();
  const chartId = await saveChart(t.pool, store, users.owner.id, project.id, spec);
  expect(await drawNext(t.pool, store, image)).toBe(true);
  await editFile(t.pool, store, csv, users.owner.id, (text) =>
    text.insert(text.length, '2024-03-04,41\n'),
  );
  await approve();
  const cut = await saveRevision(t.pool, store, users.owner.id, project.id, 'Old drawing');
  await saveChart(t.pool, store, users.owner.id, project.id, { ...spec, id: chartId });
  expect(await drawNext(t.pool, store, image)).toBe(true);
  const build = async () => {
    await requestBuild(t.pool, users.owner.id, project.id);
    expect(await buildNext(t.pool, store, image)).toBe(true);
    return submissionChecks(t.pool, store, users.owner.id, project.id);
  };
  expect(await build()).toMatchObject({ ready: true });
  await restoreRevision(t.pool, store, users.owner.id, project.id, cut.id);
  const after = await build();
  expect(after.ready).toBe(false);
  expect(after.findings).toContainEqual({
    level: 'problem',
    kind: 'chart',
    message: 'The chart "latency" is out of date: its data has changed.',
    chartId,
  });
}, 900_000);

test('a paper whose chart was put back to a drawing made with other settings is not ready', async () => {
  const main =
    '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\includegraphics{charts/latency}\n\\end{document}\n';
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(main) },
    { path: 'data/latency.csv', bytes: Buffer.from(CSV) },
  ]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Restored settings');
  const csv = (await listFiles(t.pool, users.owner.id, project.id)).find((f) =>
    f.path.endsWith('.csv'),
  )!.id;
  await approveDataset(t.pool, store, users.owner.id, project.id, csv, {
    version: (await datasetProposal(t.pool, store, users.owner.id, project.id, csv)).version,
    columns: COLUMNS,
    missing: [],
  });
  const spec = { x: 'day', y: 'latency (ms)', name: 'latency', dataset: csv };
  const chartId = await saveChart(t.pool, store, users.owner.id, project.id, {
    ...spec,
    kind: 'line',
  });
  expect(await drawNext(t.pool, store, image)).toBe(true);
  const cut = await saveRevision(t.pool, store, users.owner.id, project.id, 'As a line');
  await saveChart(t.pool, store, users.owner.id, project.id, {
    ...spec,
    kind: 'bar',
    combine: 'mean',
    id: chartId,
  });
  expect(await drawNext(t.pool, store, image)).toBe(true);
  const build = async () => {
    await requestBuild(t.pool, users.owner.id, project.id);
    expect(await buildNext(t.pool, store, image)).toBe(true);
    return submissionChecks(t.pool, store, users.owner.id, project.id);
  };
  expect(await build()).toMatchObject({ ready: true });
  await restoreRevision(t.pool, store, users.owner.id, project.id, cut.id);
  const after = await build();
  expect(after.ready).toBe(false);
  expect(after.findings).toContainEqual({
    level: 'problem',
    kind: 'chart',
    message:
      'The chart "latency" is out of date: the paper holds a drawing made with other settings. Draw it again.',
    chartId,
  });
}, 900_000);

test('a thebibliography paper is ready, and a key it does not have is the one problem', async () => {
  const clean = await verdict('Hand bib', {
    'main.tex': doc('', `Cite \\cite{a} and \\cite{b}.\n${THEBIB}`),
  });
  expect(clean.text).toEqual([]);
  expect(clean.ready).toBe(true);

  const wrong = await verdict('Hand bib nokey', {
    'main.tex': doc('', `Cite \\cite{a}, \\cite{b} and \\cite{nokey}.\n${THEBIB}`),
  });
  expect(wrong.ready).toBe(false);
  expect(wrong.problems).toHaveLength(1);
  expect(wrong.problems[0]).toMatchObject({ kind: 'citation', path: 'main.tex' });
  expect(wrong.problems[0].message).toContain('nokey');
}, 240_000);

test('a paper with a ready-made .bbl and no .bib has no missing citations', async () => {
  const found = await verdict('Bbl only', {
    'main.tex': doc('', 'Cite \\cite{k}.\n\\bibliographystyle{plain}\n\\bibliography{refs}'),
    'main.bbl':
      '\\begin{thebibliography}{1}\n\n\\bibitem{k}\nA.~One.\n\\newblock {\\em First}, 2001.\n\n\\end{thebibliography}\n',
  });
  expect(found.findings.filter((f) => f.kind === 'citation')).toEqual([]);
  expect(found.ready).toBe(true);
}, 240_000);

test('files that come with the TeX installation do not stop a paper; one that is not there does', async () => {
  const ieee = await verdict('IEEE', {
    'main.tex': doc(
      '',
      'Cite \\cite{k}.\n\\bibliographystyle{IEEEtran}\n\\bibliography{IEEEabrv,refs}',
      'IEEEtran',
    ),
    'refs.bib': BIBK,
  });
  expect(ieee.text).toEqual([]);
  expect(ieee.ready).toBe(true);
  expect(ieee.findings).toContainEqual(
    expect.objectContaining({
      level: 'warning',
      kind: 'file',
      message: '"IEEEabrv" is not among the paper\'s files; LaTeX found it elsewhere.',
    }),
  );

  const glyph = await verdict('Glyph', {
    'main.tex': doc(
      '\\usepackage{graphicx}\n\\input{glyphtounicode}\n\\pdfgentounicode=1',
      'Hi \\includegraphics[width=3cm]{example-image}',
    ),
  });
  expect(glyph.text).toEqual([]);
  expect(glyph.ready).toBe(true);

  const absent = await verdict('Absent', { 'main.tex': doc('', 'Hi \\input{nosuchfile}') });
  expect(absent.ready).toBe(false);
  expect(absent.text.join('\n')).toContain('nosuchfile');
}, 240_000);

const DOT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAAFklEQVR4nGP4DwUMSAwGBgYGQgw0XQC54i/RD0GiIwAAAABJRU5ErkJggg==',
  'base64',
);

test('a picture found through a \\graphicspath set in a read preamble file or a package is not missing', async () => {
  const body = 'Hi \\includegraphics[width=1cm]{dot}';
  const viaInput = await verdict('GraphicsInput', {
    'main.tex': doc('\\usepackage{graphicx}\n\\input{preamble}', body),
    'preamble.tex': '\\graphicspath{{figures/}}\n',
    'figures/dot.png': DOT,
  });
  expect(viaInput.text).toEqual([]);
  expect(viaInput.ready).toBe(true);
  expect(viaInput.findings.filter((f) => f.kind === 'file')).toEqual([]);
  const viaSty = await verdict('GraphicsSty', {
    'main.tex': doc('\\usepackage{graphicx}\n\\usepackage{local}', body),
    'local.sty': '\\ProvidesPackage{local}\n\\graphicspath{{figures/}}\n',
    'figures/dot.png': DOT,
  });
  expect(viaSty.text).toEqual([]);
  expect(viaSty.ready).toBe(true);
  expect(viaSty.findings.filter((f) => f.kind === 'file')).toEqual([]);
}, 240_000);

test('a label made by a package or a macro does not stop a paper', async () => {
  const lastpage = await verdict('Lastpage', {
    'main.tex': doc('\\usepackage{lastpage}', 'Page 1 of \\pageref{LastPage}.'),
  });
  expect(lastpage.text).toEqual([]);
  expect(lastpage.ready).toBe(true);

  const macro = await verdict('Macro label', {
    'main.tex': doc(
      '\\newcommand{\\mk}[1]{\\label{fig:#1}}',
      '\\section{A}\\mk{foo} See \\ref{fig:foo}.',
    ),
  });
  expect(macro.text).toEqual([]);
  expect(macro.ready).toBe(true);
  expect(macro.findings).toContainEqual(
    expect.objectContaining({
      level: 'warning',
      kind: 'label',
      message: '\\ref{fig:foo} could not be found by reading the paper; LaTeX resolved it.',
    }),
  );

  const sty = await verdict('Own sty', {
    'main.tex': doc('\\usepackage{mymacros}', '\\section{A}\\anchor See \\ref{sty:a}.'),
    'mymacros.sty': '\\ProvidesPackage{mymacros}\n\\newcommand{\\anchor}{\\label{sty:a}}\n',
  });
  expect(sty.text).toEqual([]);
  expect(sty.ready).toBe(true);
}, 240_000);

test('a citation or reference TeX cannot resolve stops a paper, however it is made', async () => {
  const old = await verdict('Old bib', {
    'main.tex': doc(
      '',
      'Cite \\cite{onlyInOld}.\n\\bibliographystyle{plain}\n\\bibliography{refs}',
    ),
    'refs.bib': BIBK,
    'old.bib': '@book{onlyInOld, author={O Ld}, title={Old}, year=1999, publisher={P}}\n',
  });
  expect(old.ready).toBe(false);
  expect(old.problems).toHaveLength(1);
  expect(old.problems[0]).toMatchObject({ kind: 'citation', path: 'main.tex', line: 4 });
  expect(old.problems[0].message).toContain('onlyInOld');

  const wrapper = await verdict('Wrapper', {
    'main.tex': doc(
      '\\newcommand{\\see}[1]{(see \\ref{#1})}',
      '\\section{A}\\label{s:a} \\see{nolabel}.',
    ),
  });
  expect(wrapper.ready).toBe(false);
  expect(wrapper.problems).toHaveLength(1);
  expect(wrapper.problems[0]).toMatchObject({ kind: 'label', path: 'main.tex', line: 4 });
  expect(wrapper.problems[0].message).toContain('nolabel');
}, 240_000);

test('an undefined reference with an accent in its key is one problem, in its own file', async () => {
  const r = await verdict('Accent ref', {
    'main.tex': doc('', '\\input{sections/méthode}'),
    'sections/méthode.tex': 'See \\ref{fig:résumé}.',
  });
  expect(r.ready).toBe(false);
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]).toMatchObject({ kind: 'label', path: 'sections/méthode.tex' });
  expect(r.problems[0].fileId).toBeTruthy();
  expect(r.problems[0].message).toContain('fig:résumé');
  expect(r.findings.some((f) => /LaTeX resolved it/.test(f.message))).toBe(false);
}, 240_000);

test('an overfull box or a font warning alone leaves a paper ready', async () => {
  const warned = await verdict('Warned', {
    'main.tex': doc(
      '',
      'Hi \\textbf{\\textsc{Small caps bold}} \\hbox to 5pt{Wideeeeeeeeeeeeeeeeeeeee word}.',
    ),
  });
  expect(warned.text).toEqual([]);
  expect(warned.ready).toBe(true);
  expect(warned.findings.some((f) => f.level === 'warning' && f.kind === 'compiler')).toBe(true);
}, 240_000);

const PGF = (body: string) =>
  [
    '\\documentclass{article}',
    '\\usepackage{pgfplots,pgfplotstable,graphicx,csvsimple}\\pgfplotsset{compat=1.16}',
    '\\pgfplotstableset{col sep=comma}',
    '\\begin{document}',
    body,
    '\\end{document}',
    '',
  ].join('\n');
const HELD_CSV = 'day,latency\n1,9\n2,38\n3,41\n';
const HELD_COLUMNS = [
  { name: 'day', type: 'number', unit: '' },
  { name: 'latency', type: 'number', unit: '' },
];

async function heldPaper(name: string, main: string, exported = false) {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(main) },
    { path: 'data.csv', bytes: Buffer.from(HELD_CSV) },
  ]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, name);
  const ids = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  await approveDataset(t.pool, store, users.owner.id, project.id, ids['data.csv'], {
    version: (await datasetProposal(t.pool, store, users.owner.id, project.id, ids['data.csv']))
      .version,
    columns: HELD_COLUMNS,
    missing: [],
    exported,
  });
  return { project, ids };
}

test.each([
  ['pgfplotstableread', '\\pgfplotstableread{data.csv}\\table\\pgfplotstabletypeset\\table'],
  ['csvreader', '\\csvreader[head to column names]{data.csv}{}{\\day\\ }'],
  ['csvautotabular', '\\csvautotabular{data.csv}'],
  [
    'addplot table',
    '\\begin{tikzpicture}\\begin{axis}\\addplot table[x=day,y=latency]{data.csv};\\end{axis}\\end{tikzpicture}',
  ],
])(
  'a paper that reads held data (%s) is not ready, and says why',
  async (_name, body) => {
    const { project } = await heldPaper(`Held ${_name}`, PGF(body));
    const checks = () => submissionChecks(t.pool, store, users.owner.id, project.id);
    await requestBuild(t.pool, users.owner.id, project.id);
    expect(await buildNext(t.pool, store, image)).toBe(true);
    const held = await checks();
    expect(held.findings.filter((f) => f.level === 'problem').map((f) => f.message)).toEqual([
      'The paper reads data.csv, which is not included in downloads: the ZIP would not build without it. Include it in downloads, or draw the chart here and include the drawing instead.',
    ]);
    expect(held).toMatchObject({ ready: false, revisionId: null });
    expect(
      (await heldDataReadBy(t.pool, store, users.owner.id, project.id)).map((h) => h.path),
    ).toEqual(['data.csv']);
    expect(heldReadMessage('data.csv')).toBe(held.findings[0].message);
  },
  900_000,
);

test('a paper that reads data included in downloads, or none, is ready', async () => {
  const read = PGF('\\pgfplotstableread{data.csv}\\table\\pgfplotstabletypeset\\table');
  const { project } = await heldPaper('Included data', read, true);
  await requestBuild(t.pool, users.owner.id, project.id);
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect(await submissionChecks(t.pool, store, users.owner.id, project.id)).toMatchObject({
    ready: true,
  });
  // Held data that nothing reads is not a problem.
  const { project: unread } = await heldPaper('Unread data', PGF('Nothing.'));
  await requestBuild(t.pool, users.owner.id, unread.id);
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect(await submissionChecks(t.pool, store, users.owner.id, unread.id)).toMatchObject({
    ready: true,
  });
}, 900_000);

test('a manifest marks the chart data held from the archive, and lists what is held', async () => {
  const { project, ids } = await heldPaper(
    'Held manifest',
    PGF('\\includegraphics{charts/latency}'),
  );
  await saveChart(t.pool, store, users.owner.id, project.id, {
    kind: 'line',
    x: 'day',
    y: 'latency',
    name: 'latency',
    dataset: ids['data.csv'],
  });
  expect(await drawNext(t.pool, store, image)).toBe(true);
  const revision = await saveRevision(t.pool, store, users.owner.id, project.id, 'Cut');
  const { zip } = await exportRevision(
    t.pool,
    store,
    users.owner.id,
    project.id,
    revision.id,
    true,
  );
  const entries = (await readZip(zip)).entries;
  expect(entries.map((e) => e.path)).not.toContain('data.csv');
  const file = join(mkdtempSync(join(tmpdir(), 'paperweave-test-')), 'revision.zip');
  writeFileSync(file, zip);
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', file, 'paperweave-toolchain.json'], { encoding: 'utf8' }),
  );
  expect(manifest.held).toEqual(['data.csv']);
  expect(Object.keys(manifest.files)).not.toContain('data.csv');
  expect(manifest.charts['charts/latency.pdf'].data).toMatchObject({
    path: 'data.csv',
    sha256: expect.stringMatching(/^sha256:|^[0-9a-f]{64}$/),
    held: true,
  });
  expect(await heldNow(t.pool, users.owner.id, project.id)).toEqual(['data.csv']);
  expect(
    (await heldInRevisions(t.pool, users.owner.id, project.id, [revision.id])).get(revision.id),
  ).toEqual(['data.csv']);
});

// A label written twice in the source counts only when TeX itself says it is multiply defined:
// text that TeX skips (\iffalse, the other arm of a switch) defines nothing.
const SKIPPED =
  '\\section{A}\\label{sec:a}\n\\iffalse\n\\section{Old}\\label{sec:a}\n\\fi\nSee \\ref{sec:a}.';
const SWITCH =
  '\\newif\\ifwide\\widetrue\n\\ifwide\\section{A}\\label{sec:a}\\else\\section{B}\\label{sec:a}\\fi\nSee \\ref{sec:a}.';
const labelsOf = (found: { findings: { level: string; kind: string }[] }, level: string) =>
  found.findings.filter((f) => f.kind === 'label' && f.level === level);

test('a label repeated only in text TeX skips does not stop a paper', async () => {
  const skipped = await verdict('Iffalse label', { 'main.tex': doc('', SKIPPED) });
  expect(skipped.text).toEqual([]);
  expect(skipped.ready).toBe(true);
  expect(labelsOf(skipped, 'warning')).toHaveLength(1);
  expect(labelsOf(skipped, 'problem')).toHaveLength(0);

  const wide = await verdict('Switch label', { 'main.tex': doc('', SWITCH) });
  expect(wide.text).toEqual([]);
  expect(wide.ready).toBe(true);
}, 240_000);

test('a label TeX really defines twice stops a paper, once', async () => {
  const twice = await verdict('Real duplicate', {
    'main.tex': doc(
      '',
      '\\section{A}\\label{sec:a}\n\\section{B}\\label{sec:a}\nSee \\ref{sec:a}.',
    ),
  });
  expect(twice.ready).toBe(false);
  expect(labelsOf(twice, 'problem')).toHaveLength(1);
  expect(twice.problems[0].message).toContain('sec:a');
}, 240_000);

test('the same skipped duplicate is a problem again once the paper has changed', async () => {
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(doc('', SKIPPED)) }]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Stale iffalse');
  await requestBuild(t.pool, users.owner.id, project.id);
  expect(await buildNext(t.pool, store, image, 90)).toBe(true);
  const checks = () => submissionChecks(t.pool, store, users.owner.id, project.id);
  expect(await checks()).toMatchObject({ ready: true });
  const main = (await listFiles(t.pool, users.owner.id, project.id)).find(
    (f) => f.path === 'main.tex',
  )!.id;
  await editFile(t.pool, store, main, users.owner.id, (text) => text.insert(text.length, '%\n'));
  const stale = await checks();
  expect(stale.ready).toBe(false);
  expect(labelsOf(stale, 'problem')).toHaveLength(1);
}, 240_000);

test('with cleveref, a label TeX defines twice is one problem, not two', async () => {
  const found = await verdict('Cleveref duplicate', {
    'main.tex': doc(
      '\\usepackage{cleveref}',
      '\\section{A}\\label{sec:a}\n\\section{B}\\label{sec:a}\nSee \\cref{sec:a}.',
    ),
  });
  expect(found.ready).toBe(false);
  expect(labelsOf(found, 'problem')).toHaveLength(1);
}, 240_000);

test('a paper built with an EPS picture in it is not ready, and the problem is in the file', async () => {
  const v = await verdict('Eps paper', {
    'main.tex': doc('\\usepackage{graphicx}', '\\includegraphics{figs/a.eps}'),
    'figs/a.eps':
      '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n0 0 10 10 rectfill\nshowpage\n',
  });
  expect(v.ready).toBe(false);
  expect(v.problems).toContainEqual(
    expect.objectContaining({
      kind: 'file',
      path: 'figs/a.eps',
      message: expect.stringMatching(/^Picture not shown: figs\/a\.eps is an EPS file/),
    }),
  );
}, 300_000);

test('a paper whose font lacks characters is not ready, and the problem is in the file', async () => {
  const v = await verdict('Glyphs paper', {
    'main.tex': doc('\\usepackage{fontspec}', '\\input{sec}'),
    'sec.tex': '5 μm and x ≤ 3 and a ≠ b.\n',
  });
  expect(v.ready).toBe(false);
  expect(v.problems).toContainEqual(
    expect.objectContaining({
      kind: 'file',
      path: 'sec.tex',
      message: expect.stringMatching(/^Characters not shown: μ ≤ ≠ are not in the font/),
    }),
  );
}, 300_000);

test('a stray character in a TikZ picture is worth a look, and the paper is ready', async () => {
  const v = await verdict('Tikz paper', {
    'main.tex': doc(
      '\\usepackage{tikz}',
      '\\begin{tikzpicture}\\draw (0,0) -- (1,1);;\\end{tikzpicture}',
    ),
  });
  expect(v.problems).toEqual([]);
  expect(v.ready).toBe(true);
  expect(v.revisionId).not.toBeNull();
  expect(v.findings).toContainEqual(
    expect.objectContaining({
      level: 'warning',
      kind: 'compiler',
      path: 'main.tex',
      message: expect.stringMatching(/^Stray character in a picture: ;/),
    }),
  );
}, 300_000);

test('the XeLaTeX paper of the fixtures is still ready', async () => {
  const dir = join(FIXTURES, 'real-xelatex');
  const v = await verdict(
    'Xelatex fixture',
    Object.fromEntries(
      Object.entries(fixtureFiles(dir)).map(([p, b]) => [
        p.slice('real-xelatex/'.length),
        Buffer.from(b),
      ]),
    ),
  );
  expect(v.problems.map((p) => p.message)).toEqual([]);
  expect(v.ready).toBe(true);
}, 300_000);

test('a paper with an abbreviation no @string defines is not ready, until one does', async () => {
  const main = doc('', 'Cite \\cite{he16}.\n\\bibliographystyle{plain}\n\\bibliography{refs}');
  const bib =
    '@article{he16,\n  author = {He, K.},\n  title = {Deep},\n  journal = cvpr,\n  year = {2016}\n}\n';
  const v = await verdict('Abbreviation paper', { 'main.tex': main, 'refs.bib': bib });
  expect(v.ready).toBe(false);
  expect(v.problems).toContainEqual(
    expect.objectContaining({
      kind: 'file',
      path: 'refs.bib',
      line: 4,
      message: expect.stringMatching(/^Abbreviation not defined: "cvpr" is used in refs\.bib/),
    }),
  );
  const fixed = await verdict('Abbreviation defined', {
    'main.tex': main,
    'refs.bib': `@string{cvpr = "CVPR"}\n${bib}`,
  });
  expect(fixed.text).toEqual([]);
  expect(fixed.ready).toBe(true);
}, 300_000);
