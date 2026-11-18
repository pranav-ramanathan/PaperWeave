// Needs the services in infra/compose.yaml and the toolchain image. Run: pnpm test:sandbox
import {
  acceptInvitation,
  approveDataset,
  blobStore,
  chartPng,
  editFile,
  exportZip,
  importZip,
  invite,
  latestBuilds,
  listCharts,
  listFiles,
  readZip,
  removeChart,
  requestBuild,
  saveChart,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { buildNext, imageId } from './builder.ts';
import { drawNext } from './charts.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
const users = {} as Record<'owner' | 'viewer' | 'outsider', { id: string; email: string }>;

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
});
afterAll(() => t.close());

const MAIN =
  '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\includegraphics{charts/latency}\n\\end{document}\n';
const CSV = 'day,latency (ms),site\n2024-03-01,9,Lab\n2024-03-02,NA,Lab\n2024-03-03,38,Lab\n';
const COLUMNS = [
  { name: 'day', type: 'date', unit: '' },
  { name: 'latency (ms)', type: 'number', unit: 'ms' },
  { name: 'site', type: 'text', unit: '' },
];
const LINE = { kind: 'line', x: 'day', y: 'latency (ms)', gaps: 'join' };
async function paper() {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: 'data/latency.csv', bytes: Buffer.from(CSV) },
  ]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Charts');
  const { token } = await invite(t.pool, users.owner.id, project.id, users.viewer.email, 'viewer');
  await acceptInvitation(t.pool, users.viewer.id, token);
  const csv = (await listFiles(t.pool, users.owner.id, project.id)).find((f) =>
    f.path.endsWith('.csv'),
  )!.id;
  return { id: project.id, csv };
}
const approve = async (p: { id: string; csv: string }) => {
  const { version } = await import('@paperweave/server').then((s) =>
    s.datasetProposal(t.pool, store, users.owner.id, p.id, p.csv),
  );
  await approveDataset(t.pool, store, users.owner.id, p.id, p.csv, {
    version,
    columns: COLUMNS,
    missing: ['NA'],
    exported: true,
  });
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );
const charts = (p: { id: string }) => listCharts(t.pool, store, users.viewer.id, p.id);

test('a chart is drawn from approved data into files of the paper, which a build can use', async () => {
  const p = await paper();
  // Not before someone has said what the file holds.
  expect(
    await code(
      saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, name: 'latency', dataset: p.csv }),
    ),
  ).toBe('invalid_input');
  await approve(p);
  const id = await saveChart(t.pool, store, users.owner.id, p.id, {
    ...LINE,
    name: 'latency',
    dataset: p.csv,
  });
  expect(await charts(p)).toMatchObject([
    { id, name: 'latency', dataPath: 'data/latency.csv', status: 'queued', stale: false },
  ]);
  expect(await code(chartPng(t.pool, store, users.owner.id, p.id, id))).toBe('not_found');

  expect(await drawNext(t.pool, store)).toBe(true);
  expect(await drawNext(t.pool, store)).toBe(false);
  expect(await charts(p)).toMatchObject([
    {
      status: 'drawn',
      stale: false,
      problem: null,
      // The row with no latency.
      leftOut: 1,
      alt: 'Line chart of latency (ms) against day.',
    },
  ]);
  const png = await chartPng(t.pool, store, users.viewer.id, p.id, id);
  expect(Buffer.from(png.slice(1, 4)).toString()).toBe('PNG');
  const files = (await readZip(await exportZip(t.pool, store, users.owner.id, p.id))).entries;
  const pdf = files.find((f) => f.path === 'charts/latency.pdf')!;
  expect(Buffer.from(pdf.bytes.slice(0, 5)).toString()).toBe('%PDF-');
  expect(files.map((f) => f.path)).toContain('charts/latency.png');

  // The paper includes the chart by name, and builds.
  await requestBuild(t.pool, users.owner.id, p.id);
  expect(await buildNext(t.pool, store, imageId())).toBe(true);
  expect((await latestBuilds(t.pool, users.owner.id, p.id)).latest).toMatchObject({
    status: 'succeeded',
  });

  // Drawing the same chart of the same data again gives the same files.
  await saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, id });
  expect(await drawNext(t.pool, store)).toBe(true);
  const again = (await readZip(await exportZip(t.pool, store, users.owner.id, p.id))).entries;
  expect(Buffer.from(again.find((f) => f.path === 'charts/latency.pdf')!.bytes)).toEqual(
    Buffer.from(pdf.bytes),
  );
}, 120_000);

test('a chart is out of date once its data changes, and is not redrawn from data nobody approved', async () => {
  const p = await paper();
  await approve(p);
  const id = await saveChart(t.pool, store, users.owner.id, p.id, {
    ...LINE,
    name: 'latency',
    dataset: p.csv,
  });
  await drawNext(t.pool, store);
  await editFile(t.pool, store, p.csv, users.owner.id, (text) =>
    text.insert(text.length, '2024-03-04,41,Lab\n'),
  );
  expect(await charts(p)).toMatchObject([{ status: 'drawn', stale: true }]);
  // Asking for it again does not help until the new version has been looked at.
  expect(await code(saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, id }))).toBe(
    'conflict',
  );
  await approve(p);
  await saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, id });
  // Changed again between the request and the drawing: the worker refuses too, and says why.
  await editFile(t.pool, store, p.csv, users.owner.id, (text) =>
    text.insert(text.length, '2024-03-05,44,Lab\n'),
  );
  expect(await drawNext(t.pool, store)).toBe(true);
  expect(await charts(p)).toMatchObject([
    { status: 'failed', problem: expect.stringContaining('has changed since') },
  ]);
  await approve(p);
  await saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, id });
  expect(await drawNext(t.pool, store)).toBe(true);
  expect(await charts(p)).toMatchObject([{ status: 'drawn', stale: false, leftOut: 1 }]);
}, 120_000);

test('charts keep to their paper, their name and the people who may change them', async () => {
  const p = await paper();
  await approve(p);
  const make = (who: keyof typeof users, more: object = {}) =>
    saveChart(t.pool, store, users[who].id, p.id, {
      ...LINE,
      name: 'latency',
      dataset: p.csv,
      ...more,
    });
  expect(await code(make('viewer'))).toBe('permission_denied');
  expect(await code(make('outsider'))).toBe('not_found');
  for (const name of ['', 'Latency', '../x', 'a b', 'x'.repeat(41)])
    expect(await code(make('owner', { name })), name).toBe('invalid_input');
  const id = await make('owner');
  expect(await code(make('owner'))).toBe('conflict');
  // A name whose files someone has already put in the paper.
  const { createFile } = await import('@paperweave/server');
  await createFile(t.pool, store, users.owner.id, p.id, 'charts/mine.png', Buffer.from([1, 2]));
  expect(await code(make('owner', { name: 'mine' }))).toBe('conflict');

  // Not through another paper, and not by someone who cannot see this one.
  const other = await paper();
  expect(await code(saveChart(t.pool, store, users.owner.id, other.id, { ...LINE, id }))).toBe(
    'not_found',
  );
  expect(await code(make('owner', { name: 'theirs', dataset: other.csv }))).toBe('invalid_input');
  expect(await code(listCharts(t.pool, store, users.outsider.id, p.id))).toBe('not_found');
  expect(await code(chartPng(t.pool, store, users.outsider.id, p.id, id))).toBe('not_found');
  expect(await code(removeChart(t.pool, users.viewer.id, p.id, id))).toBe('permission_denied');
  expect(await code(removeChart(t.pool, users.owner.id, other.id, id))).toBe('not_found');
  await removeChart(t.pool, users.owner.id, p.id, id);
  expect(await charts(p)).toEqual([]);
  // Nothing of another paper's was left queued for the next test.
  while (await drawNext(t.pool, store));
}, 120_000);
