// Needs the services in infra/compose.yaml and the toolchain image. Run: pnpm test:sandbox
import {
  acceptInvitation,
  approveDataset,
  blobStore,
  datasetProposal,
  editFile,
  importZip,
  invite,
  listFiles,
  requestBuild,
  saveChart,
  submissionChecks,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
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
