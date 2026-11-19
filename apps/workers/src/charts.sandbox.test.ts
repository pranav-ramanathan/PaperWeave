// Needs the services in infra/compose.yaml and the toolchain image. Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptInvitation,
  approveDataset,
  blobStore,
  chartDraws,
  chartPng,
  deleteFile,
  editFile,
  exportRevision,
  exportZip,
  importZip,
  invite,
  latestBuilds,
  listCharts,
  listFiles,
  picture,
  pictures,
  readZip,
  removeChart,
  requestBuild,
  restoreRevision,
  saveChart,
  saveRevision,
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
  // While it waits it says since when, so that a page can tell a wait from a drawing service
  // that is not running. Once drawn it does not.
  const since = (await charts(p))[0].waitingSince!;
  expect(Date.now() - Date.parse(since)).toBeLessThan(60_000);
  expect(await code(chartPng(t.pool, store, users.owner.id, p.id, id))).toBe('not_found');

  expect(await drawNext(t.pool, store, image)).toBe(true);
  expect(await drawNext(t.pool, store, image)).toBe(false);
  expect(await charts(p)).toMatchObject([
    {
      status: 'drawn',
      stale: false,
      problem: null,
      waitingSince: null,
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
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect((await latestBuilds(t.pool, users.owner.id, p.id)).latest).toMatchObject({
    status: 'succeeded',
  });

  // Drawing the same chart of the same data again gives the same files.
  await saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, id });
  expect(await drawNext(t.pool, store, image)).toBe(true);
  const again = (await readZip(await exportZip(t.pool, store, users.owner.id, p.id))).entries;
  expect(Buffer.from(again.find((f) => f.path === 'charts/latency.pdf')!.bytes)).toEqual(
    Buffer.from(pdf.bytes),
  );

  // Each drawing runs a sandbox, so a paper's charts are drawn only so often in an hour. It
  // has been asked for twice here, and the second gave the same files as the first.
  expect(await code(saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, id }, 2))).toBe(
    'conflict',
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
  await drawNext(t.pool, store, image);
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
  expect(await drawNext(t.pool, store, image)).toBe(true);
  expect(await charts(p)).toMatchObject([
    { status: 'failed', problem: expect.stringContaining('has changed since') },
  ]);
  await approve(p);
  await saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, id });
  expect(await drawNext(t.pool, store, image)).toBe(true);
  expect(await charts(p)).toMatchObject([{ status: 'drawn', stale: false, leftOut: 1 }]);
}, 120_000);

test('a chart whose files have left the paper says so, and drawing it again puts them back', async () => {
  const p = await paper();
  const before = await saveRevision(t.pool, store, users.owner.id, p.id, 'Before the chart');
  await approve(p);
  const id = await saveChart(t.pool, store, users.owner.id, p.id, {
    ...LINE,
    name: 'latency',
    dataset: p.csv,
  });
  expect(await charts(p)).toMatchObject([{ status: 'queued', missing: false }]);
  await drawNext(t.pool, store, image);
  expect(await charts(p)).toMatchObject([{ status: 'drawn', missing: false }]);
  const redraw = async () => {
    await saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, id });
    // Still missing while it waits to be drawn: there is no picture to show yet.
    expect(await charts(p)).toMatchObject([{ status: 'queued', missing: true }]);
    expect(await drawNext(t.pool, store, image)).toBe(true);
    expect(await charts(p)).toMatchObject([{ status: 'drawn', missing: false, stale: false }]);
    await chartPng(t.pool, store, users.viewer.id, p.id, id);
  };

  // One of its two files is deleted by hand.
  const pdf = (await listFiles(t.pool, users.owner.id, p.id)).find(
    (f) => f.path === 'charts/latency.pdf',
  )!;
  await deleteFile(t.pool, store, users.owner.id, p.id, pdf.id);
  expect(await charts(p)).toMatchObject([{ status: 'drawn', missing: true, stale: false }]);
  await redraw();

  // The paper is put back to how it was before the chart was drawn: both files go.
  await restoreRevision(t.pool, store, users.owner.id, p.id, before.id);
  expect(await charts(p)).toMatchObject([{ status: 'drawn', missing: true }]);
  expect(await code(chartPng(t.pool, store, users.viewer.id, p.id, id))).toBe('not_found');
  await redraw();
}, 120_000);

test('a chart carries its caption, its description and the record of how it was made', async () => {
  const p = await paper();
  await approve(p);
  const make = { ...LINE, name: 'latency', dataset: p.csv };
  // Both go into LaTeX as written, so neither may break it.
  expect(
    await code(saveChart(t.pool, store, users.owner.id, p.id, { ...make, caption: '50% & up' })),
  ).toBe('invalid_input');
  expect(
    await code(saveChart(t.pool, store, users.owner.id, p.id, { ...make, alt: 'a } b' })),
  ).toBe('invalid_input');
  const id = await saveChart(t.pool, store, users.owner.id, p.id, {
    ...make,
    caption: '  Latency over\nthree days. ',
  });
  await drawNext(t.pool, store, image);
  expect(await charts(p)).toMatchObject([
    // Nobody wrote a description: ours stands in.
    { caption: 'Latency over three days.', alt: 'Line chart of latency (ms) against day.' },
  ]);
  // Changed to bars: our sentence follows the chart. The author's own words would be kept.
  await saveChart(t.pool, store, users.owner.id, p.id, {
    id,
    kind: 'bar',
    x: 'day',
    y: 'latency (ms)',
    caption: 'Latency over three days.',
    alt: 'Line chart of latency (ms) against day.',
  });
  await drawNext(t.pool, store, image);
  expect((await charts(p))[0].alt).toBe('Bar chart of latency (ms) against day.');
  await saveChart(t.pool, store, users.owner.id, p.id, { ...LINE, id, alt: 'Latency rises.' });
  await drawNext(t.pool, store, image);
  expect((await charts(p))[0]).toMatchObject({ alt: 'Latency rises.', caption: '' });

  // Each drawing is written down: the first and the third are the same chart of the same data
  // with the same tools, so they are one entry.
  const draws = await chartDraws(t.pool, users.viewer.id, p.id, 'latency');
  expect(draws.map((d) => d.record.chart.kind)).toEqual(['bar', 'line']);
  const version = (await charts(p))[0].version;
  expect(draws[1].record).toMatchObject({
    data: {
      path: 'data/latency.csv',
      sha256: version,
      // Only the columns the chart uses, with their units.
      columns: [COLUMNS[0], COLUMNS[1]],
      missing: ['NA'],
    },
    rowsLeftOut: 1,
    generator: { image, vega: expect.any(String), 'vega-lite': expect.any(String) },
  });
  expect(await code(chartDraws(t.pool, users.outsider.id, p.id, 'latency'))).toBe('not_found');

  // The picture list offers the chart once, as its PDF, with its words. The editor shows the
  // PNG in the PDF's place.
  expect(await pictures(t.pool, users.viewer.id, p.id)).toEqual([
    {
      path: 'charts/latency.pdf',
      target: 'charts/latency.pdf',
      caption: '',
      alt: 'Latency rises.',
    },
  ]);
  expect(await picture(t.pool, store, users.viewer.id, p.id, 'charts/latency')).toMatchObject({
    type: 'image/png',
    path: 'charts/latency.pdf',
  });

  // A download that says how to rebuild the paper also says where its chart came from, by the
  // bytes of the file in that revision.
  const saved = await saveRevision(t.pool, store, users.owner.id, p.id, 'With the line chart');
  await saveChart(t.pool, store, users.owner.id, p.id, {
    id,
    kind: 'bar',
    x: 'day',
    y: 'latency (ms)',
  });
  await drawNext(t.pool, store, image);
  const { zip } = await exportRevision(t.pool, store, users.owner.id, p.id, saved.id, true);
  // Read with the system unzip: our own reader leaves out files a paper does not use.
  const file = join(mkdtempSync(join(tmpdir(), 'paperweave-test-')), 'revision.zip');
  writeFileSync(file, zip);
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', file, 'paperweave-toolchain.json'], { encoding: 'utf8' }),
  );
  expect(Object.keys(manifest.charts).sort()).toEqual(['charts/latency.pdf', 'charts/latency.png']);
  expect(manifest.charts['charts/latency.pdf']).toMatchObject({
    data: { path: 'data/latency.csv', sha256: version },
    chart: { kind: 'line', x: 'day', y: 'latency (ms)' },
  });
  // Removing the chart from the list does not remove the record of what was drawn.
  await removeChart(t.pool, users.owner.id, p.id, id);
  expect(await chartDraws(t.pool, users.owner.id, p.id, 'latency')).toHaveLength(2);
}, 180_000);

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
  while (await drawNext(t.pool, store, image));
}, 120_000);
