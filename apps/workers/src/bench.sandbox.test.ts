// How long the things people wait for take, measured on this machine and written down in
// docs/benchmarks.md: WRITE_BENCH=1 SANDBOX=1 pnpm vitest run apps/workers/src/bench
// Without WRITE_BENCH it only holds each number under a generous ceiling, so that something
// becoming ten times slower is noticed. Needs the services, the toolchain image and Docker.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';
import { parse, reparse } from '@paperweave/latex';
import {
  appendUpdate,
  approveDataset,
  blobStore,
  checkGrammar,
  compactFile,
  datasetProposal,
  exportZip,
  importZip,
  latestBuilds,
  listFiles,
  loadUpdates,
  requestBuild,
  saveChart,
  TEXT,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { FIXTURES } from '../../../packages/latex/src/testutil.ts';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { buildNext, imageId } from './builder.ts';
import { drawNext } from './charts.ts';

const ROOT = join(import.meta.dirname, '../../..');
const store = blobStore(TEST_ENV);
const image = imageId();
let t: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());

const ms = async (work: () => unknown) => {
  const start = performance.now();
  await work();
  return performance.now() - start;
};
/** The middle of several runs: one slow run does not make the number. */
const median = async (runs: number, work: () => unknown) => {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) times.push(await ms(work));
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
};
function fixture(name: string) {
  const root = join(FIXTURES, name);
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(root, p), bytes: readFileSync(p) });
    }
  };
  walk(root);
  return files;
}

test('the things people wait for, measured', async () => {
  const owner = await t.signIn('owner@example.org');
  const results: [string, number, string, number][] = [];
  /** Record a measurement, and hold it under a ceiling far above what it should be. */
  const took = (what: string, value: number, unit: string, ceiling: number) => {
    results.push([what, value, unit, ceiling]);
    expect(value, what).toBeLessThan(ceiling);
  };

  // Reading a long file, and reading it again after one keystroke.
  const section = readFileSync(join(FIXTURES, 'ieee-multifile/sections/method.tex'), 'utf8');
  const long = `\\begin{document}\n${section.repeat(Math.ceil(150_000 / section.length))}\\end{document}\n`;
  let parsed = parse(long);
  took('Parse a 150 KB file', await median(9, () => parse(long)), 'ms', 500);
  const at = long.indexOf('edit', long.length / 2);
  took(
    'Parse it again after one keystroke',
    await median(9, () => {
      parsed = reparse(parsed, `${long.slice(0, at)}x${long.slice(at)}`);
    }),
    'ms',
    100,
  );

  // Bringing a paper in, and taking it out.
  const zip = await writeZip(fixture('ieee-multifile'));
  let paper = '';
  took(
    'Import a six-file paper',
    await ms(async () => {
      paper = (await importZip(t.pool, store, owner.id, zip, 'Bench'))[0].id;
    }),
    'ms',
    5000,
  );
  took(
    'Download it as a ZIP',
    await ms(() => exportZip(t.pool, store, owner.id, paper)),
    'ms',
    5000,
  );
  const files = await listFiles(t.pool, owner.id, paper);
  const intro = files.find((f) => f.path === 'sections/intro.tex')!.id;

  // Saving keystrokes, opening a file with a long history, and compacting that history.
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, intro)) Y.applyUpdate(doc, u);
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  for (let i = 0; i < 1000; i++) doc.getText(TEXT).insert(i, 'x');
  const saving = await ms(async () => {
    for (const u of updates) await appendUpdate(t.pool, intro, owner.id, u);
  });
  took('Save one keystroke', saving / updates.length, 'ms', 50);
  took(
    'Open a file with 1,000 edits in its log',
    await median(5, () => loadUpdates(t.pool, store, intro)),
    'ms',
    2000,
  );
  took('Compact that log', await ms(() => compactFile(t.pool, intro)), 'ms', 5000);

  // Building: from nothing, and again with nothing changed.
  const build = async () => {
    await requestBuild(t.pool, owner.id, paper);
    await buildNext(t.pool, store, image);
  };
  took('Build the paper to a PDF', (await ms(build)) / 1000, 's', 120);
  expect((await latestBuilds(t.pool, owner.id, paper)).latest).toMatchObject({
    status: 'succeeded',
  });
  took('Build it again, nothing changed', await ms(build), 'ms', 5000);

  // Spelling and grammar on a section. The first time a text is asked about, and the second.
  const method = files.find((f) => f.path === 'sections/method.tex')!.id;
  const check = () =>
    checkGrammar(t.pool, store, owner.id, paper, method, { url: TEST_ENV.GRAMMAR_URL });
  await checkGrammar(t.pool, store, owner.id, paper, intro, { url: TEST_ENV.GRAMMAR_URL });
  took('Check the spelling and grammar of a section', await ms(check), 'ms', 20_000);
  took('Check it again, nothing changed', await ms(check), 'ms', 2000);

  // Drawing a chart.
  const data =
    'day,latency (ms)\n' +
    Array.from({ length: 200 }, (_, i) => `${i},${i % 17}`).join('\n') +
    '\n';
  const [charted] = await importZip(
    t.pool,
    store,
    owner.id,
    await writeZip([
      {
        path: 'main.tex',
        bytes: Buffer.from('\\documentclass{article}\\begin{document}x\\end{document}\n'),
      },
      { path: 'data.csv', bytes: Buffer.from(data) },
    ]),
    'Chart bench',
  );
  const csv = (await listFiles(t.pool, owner.id, charted.id)).find(
    (f) => f.path === 'data.csv',
  )!.id;
  const seen = await datasetProposal(t.pool, store, owner.id, charted.id, csv);
  await approveDataset(t.pool, store, owner.id, charted.id, csv, {
    version: seen.version,
    columns: seen.guess.columns.map((c) => ({ name: c.name, type: c.type, unit: c.unit })),
    missing: [],
  });
  await saveChart(t.pool, store, owner.id, charted.id, {
    name: 'bench',
    dataset: csv,
    kind: 'scatter',
    x: 'day',
    y: 'latency (ms)',
  });
  took(
    'Draw a chart of 200 points to PDF and PNG',
    (await ms(() => drawNext(t.pool, store, image))) / 1000,
    's',
    60,
  );

  writeFileSync(join(ROOT, 'test-results-bench.json'), JSON.stringify(results, null, 2));
  if (!process.env.WRITE_BENCH) return;
  const show = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
  writeFileSync(
    join(ROOT, 'docs/benchmarks.md'),
    [
      '# Benchmarks',
      '',
      'How long the things people wait for take. Measured by',
      '`apps/workers/src/bench.sandbox.test.ts` on one machine, once, so read them as sizes and not',
      'as promises:',
      `${cpus().length} cores of ${cpus()[0].model.trim()}, Node ${process.version}, with the`,
      'services of `infra/compose.yaml` on the same machine. The same test runs in CI and fails if',
      'any of these passes its ceiling, which is set far above the measurement so that only a',
      'large slowdown trips it.',
      '',
      '| What | Took | Ceiling |',
      '| --- | --- | --- |',
      ...results.map(
        ([what, value, unit, ceiling]) =>
          `| ${what} | ${show(value)} ${unit} | ${ceiling} ${unit} |`,
      ),
      '',
      'In the browser, from `tests/e2e/spike.spec.ts` on a 150 KB file: a keystroke reaches the',
      'source text within 40 ms and the screen within 150 ms at the 95th percentile, and another',
      "person's edit is on screen within 250 ms. Those are that test's limits; it prints what it",
      'measured on each run.',
      '',
      '## Not measured',
      '',
      '- Many people in one file at once, or many files open at once on one sync server.',
      '- Papers much larger than the fixtures: hundreds of files, or a hundred pages.',
      '- Anything over a real network. Everything here ran on one machine.',
      '- A build queue under load: one worker built one paper at a time here.',
      '',
    ].join('\n'),
  );
}, 600_000);
