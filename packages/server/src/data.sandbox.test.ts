// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { approveDataset, datasetProposal, datasetTable, listDatasets } from './data.ts';
import { exportZip, importReport, importZip, listFiles } from './import.ts';
import { acceptInvitation, invite } from './projects.ts';
import { renameFile } from './revisions.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
import { startThread } from './threads.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
const users = {} as Record<'owner' | 'viewer' | 'outsider', { id: string; email: string }>;

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
});
afterAll(() => t.close());

// A quoted name with a comma in it, a unit in a column name, and gaps written three ways.
const CSV =
  'site,writers,"latency, p95 (ms)",note\r\n"Lab, north",1,9,\r\n"Lab, north",3,NA,"said ""slow"""\r\nField,5,38,\r\nField,8,n/a,retry\r\n';
const FILES = {
  'main.tex': '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n',
  'data/latency.csv': CSV,
  'data/other.csv': 'a,b\n1,2\n',
  'notes.txt': 'not data\n',
};
async function paper() {
  const zip = await writeZip(
    Object.entries(FILES).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Data');
  const { token } = await invite(t.pool, users.owner.id, project.id, users.viewer.email, 'viewer');
  await acceptInvitation(t.pool, users.viewer.id, token);
  const ids = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  return { id: project.id, csv: ids['data/latency.csv'], ids };
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );
const COLUMNS = [
  { name: 'site', type: 'text', unit: '' },
  { name: 'writers', type: 'number', unit: '' },
  { name: 'latency, p95 (ms)', type: 'number', unit: 'ms' },
  { name: 'note', type: 'text', unit: '' },
];

test('a CSV file is read, guessed at, and described by its author for one exact version', async () => {
  const p = await paper();
  const seen = await datasetProposal(t.pool, store, users.viewer.id, p.id, p.csv);
  expect(seen.path).toBe('data/latency.csv');
  expect(seen.approved).toBeNull();
  expect(seen.guess.rows).toBe(4);
  expect(seen.guess.missing).toEqual(['', 'NA', 'n/a']);
  expect(seen.guess.columns.map((c) => [c.name, c.type, c.unit, c.missing])).toEqual([
    ['site', 'text', '', 0],
    ['writers', 'number', '', 0],
    ['latency, p95 (ms)', 'number', 'ms', 2],
    ['note', 'text', '', 2],
  ]);

  const approve = (who: string, input: object) =>
    approveDataset(t.pool, store, who, p.id, p.csv, {
      version: seen.version,
      columns: COLUMNS,
      missing: ['', 'NA', 'n/a'],
      ...input,
    });
  // A value that is not what its column is said to hold is named, with its row.
  await expect(approve(users.owner.id, { missing: ['', 'NA'] })).rejects.toThrow(
    '"latency, p95 (ms)", row 5: "n/a" is not a number.',
  );
  for (const bad of [
    { version: 'x'.repeat(64) },
    { columns: COLUMNS.slice(0, 3) },
    { columns: COLUMNS.map((c, i) => (i ? c : { ...c, name: 'place' })) },
    { columns: COLUMNS.map((c, i) => (i ? c : { ...c, type: 'money' })) },
    { missing: 'NA' },
    { attribution: 'x'.repeat(2001) },
  ])
    expect(await code(approve(users.owner.id, bad)), JSON.stringify(bad).slice(0, 50)).toMatch(
      /invalid_input|conflict/,
    );
  expect(await code(approve(users.viewer.id, {}))).toBe('permission_denied');
  expect(await code(approve(users.outsider.id, {}))).toBe('not_found');
  expect(await listDatasets(t.pool, store, users.owner.id, p.id)).toEqual([]);

  await approve(users.owner.id, { attribution: 'Measured by us, March 2024.' });
  const [dataset] = await listDatasets(t.pool, store, users.viewer.id, p.id);
  expect(dataset).toMatchObject({
    path: 'data/latency.csv',
    columns: COLUMNS,
    missing: ['', 'NA', 'n/a'],
    attribution: 'Measured by us, March 2024.',
    exported: false,
    approvedBy: 'owner@example.org',
    version: seen.version,
    changed: false,
  });
  // Read with that description: numbers are numbers, and a gap is a gap however it was spelt.
  const table = await datasetTable(t.pool, store, p.id, p.csv);
  expect(table.rows).toEqual([
    ['Lab, north', 1, 9, null],
    ['Lab, north', 3, null, 'said "slow"'],
    ['Field', 5, 38, null],
    ['Field', 8, null, 'retry'],
  ]);
  expect(table.version).toBe(seen.version);

  // The file is edited: the description is now of an older version, and nothing reads the new
  // data as if it had been looked at.
  await editFile(t.pool, store, p.csv, users.owner.id, (text) =>
    text.insert(text.length, 'Field,13,71,\n'),
  );
  expect((await listDatasets(t.pool, store, users.owner.id, p.id))[0].changed).toBe(true);
  expect(await code(datasetTable(t.pool, store, p.id, p.csv))).toBe('conflict');
  expect(await code(approve(users.owner.id, {}))).toBe('conflict');
  const again = await datasetProposal(t.pool, store, users.owner.id, p.id, p.csv);
  expect(again.guess.rows).toBe(5);
  expect(again.approved?.changed).toBe(true);
  await approveDataset(t.pool, store, users.owner.id, p.id, p.csv, {
    version: again.version,
    columns: COLUMNS,
    missing: ['', 'NA', 'n/a'],
  });
  expect((await datasetTable(t.pool, store, p.id, p.csv)).rows).toHaveLength(5);

  // Only a CSV file of this paper can be data.
  for (const file of [p.ids['notes.txt'], p.ids['main.tex'], (await paper()).csv])
    expect(await code(datasetProposal(t.pool, store, users.owner.id, p.id, file))).toBe(
      'not_found',
    );
});

test('data goes into a download only when its author has said so', async () => {
  const p = await paper();
  const paths = async () =>
    (await readZip(await exportZip(t.pool, store, users.owner.id, p.id))).entries
      .map((e) => e.path)
      .sort();
  // Nobody has described anything: every file is a file.
  expect(await paths()).toEqual(['data/latency.csv', 'data/other.csv', 'main.tex', 'notes.txt']);
  const seen = await datasetProposal(t.pool, store, users.owner.id, p.id, p.csv);
  const approve = (exported: boolean) =>
    approveDataset(t.pool, store, users.owner.id, p.id, p.csv, {
      version: seen.version,
      columns: COLUMNS,
      missing: ['', 'NA', 'n/a'],
      exported,
    });
  await approve(false);
  // Described as data and not released: held back. The CSV nobody described still goes.
  expect(await paths()).toEqual(['data/other.csv', 'main.tex', 'notes.txt']);
  await approve(true);
  const back = await readZip(await exportZip(t.pool, store, users.owner.id, p.id));
  expect(back.entries.map((e) => e.path).sort()).toEqual([
    'data/latency.csv',
    'data/other.csv',
    'main.tex',
    'notes.txt',
  ]);
  // Released, it is the file byte for byte.
  expect(
    Buffer.from(back.entries.find((e) => e.path === 'data/latency.csv')!.bytes).toString(),
  ).toBe(CSV);
});

test('comments and proposals on held data stay out of the review ZIP, by file, not by name', async () => {
  const p = await paper();
  const row = 'Lab, north';
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, p.csv)) Y.applyUpdate(doc, u);
  const text = doc.getText(TEXT);
  const at = text.toString().indexOf(row);
  const pos = (i: number, side: number) =>
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, i, side));
  await startThread(t.pool, store, users.owner.id, p.id, p.csv, {
    from: pos(at, 0),
    to: pos(at + row.length, -1),
    body: 'Is this row right?',
  });
  const seen = await datasetProposal(t.pool, store, users.owner.id, p.id, p.csv);
  const approve = (exported: boolean) =>
    approveDataset(t.pool, store, users.owner.id, p.id, p.csv, {
      version: seen.version,
      columns: COLUMNS,
      missing: ['', 'NA', 'n/a'],
      exported,
    });
  const review = async () => {
    const zip = await exportZip(t.pool, store, users.owner.id, p.id, { review: true });
    const { entries, review } = await readZip(zip);
    return {
      zip,
      joined: [...entries, ...review]
        .map((e) => Buffer.from(e.bytes).toString('latin1'))
        .join('\n'),
    };
  };
  await approve(false);
  const held = await review();
  expect(held.joined).not.toContain(row);
  // Imported, the archive says what was left out, in counts.
  const [arrived] = await importZip(t.pool, store, users.outsider.id, held.zip, 'Arrived');
  const report = (await importReport(t.pool, users.outsider.id, arrived.id))!;
  expect(report.review!.missing).toEqual([
    '1 thread on data/latency.csv was left out where this came from: the file is kept back from downloads.',
  ]);
  // A new name does not let it out.
  await renameFile(t.pool, users.owner.id, p.id, p.csv, 'data/renamed.csv');
  expect((await review()).joined).not.toContain(row);
  // Released, it goes with the file.
  await approve(true);
  expect((await review()).joined).toContain('Is this row right?');
});
