// Needs Docker, the TeX image and the services in infra/compose.yaml. Run: pnpm test:sandbox
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  acceptInvitation,
  appendUpdate,
  blobStore,
  buildLabels,
  buildOutput,
  createFile,
  deleteFile,
  importZip,
  invite,
  latestBuilds,
  listFiles,
  loadUpdates,
  requestBuild,
  TEXT,
  writeZip,
  pdfToSource,
  putFile,
  setRootFile,
  sourceToPdf,
  submissionChecks,
} from '@paperweave/server';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { labelIndex } from '../../../packages/latex/src/labels.ts';
import { FIXTURES } from '../../../packages/latex/src/testutil.ts';
import { pdfText } from '../../../packages/server/src/pdftext.ts';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { buildNext, imageId } from './builder.ts';

const store = blobStore(TEST_ENV);
const image = imageId();
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let viewer: { id: string; email: string };
let outsider: { id: string };

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  viewer = await t.signIn('viewer@example.org');
  outsider = await t.signIn('outsider@example.org');
});
afterAll(() => t.close());

async function paper(name = 'article-basic') {
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
  const [project] = await importZip(t.pool, store, owner.id, await writeZip(files), name);
  const main = (await listFiles(t.pool, owner.id, project.id)).find((f) => f.path === 'main.tex')!;
  return { project: project.id, main: main.id };
}

/** Edit a file the way a connected editor would: one update appended to its log. */
async function edit(file: string, change: (text: Y.Text) => void) {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  const before = Y.encodeStateVector(doc);
  change(doc.getText(TEXT));
  expect(
    await appendUpdate(t.pool, file, owner.id, Y.encodeStateAsUpdate(doc, before)),
  ).not.toBeNull();
}

/** Ask for a build and run the worker until it is done. */
async function build(project: string, img = image) {
  const id = await requestBuild(t.pool, owner.id, project);
  expect(await buildNext(t.pool, store, img)).toBe(true);
  const { latest } = await latestBuilds(t.pool, owner.id, project);
  expect(latest!.id).toBe(id);
  return latest!;
}
const digest = async (id: string) =>
  (await t.pool.query('select pdf_digest from builds where id = $1', [id])).rows[0].pdf_digest;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test('a paper builds to a PDF, and the same inputs are never built twice', async () => {
  const { project, main } = await paper();
  const first = await build(project);
  expect(first).toMatchObject({ status: 'succeeded', hasPdf: true, cached: false, stale: false });
  expect(first.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const pdf = await buildOutput(t.pool, store, owner.id, project, first.id, 'pdf');
  expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
  expect(
    (await buildOutput(t.pool, store, owner.id, project, first.id, 'log')).length,
  ).toBeGreaterThan(100);
  expect(await buildNext(t.pool, store, image)).toBe(false);

  // Nothing changed: the result comes from the cache.
  const again = await build(project);
  expect(again).toMatchObject({ status: 'succeeded', cached: true });
  expect(await digest(again.id)).toBe(await digest(first.id));

  // An edit makes the old build out of date and the next one a real build.
  await edit(main, (text) =>
    text.insert(text.toString().indexOf('Collaborative'), 'Fresh words. '),
  );
  expect((await latestBuilds(t.pool, owner.id, project)).latest!.stale).toBe(true);
  const edited = await build(project);
  expect(edited).toMatchObject({ status: 'succeeded', cached: false, stale: false });
  expect(await digest(edited.id)).not.toBe(await digest(first.id));

  // So does a different toolchain image, and a different compiler.
  expect((await build(project, 'sha256:some-other-image')).cached).toBe(false);
  await t.pool.query("update projects set compiler = 'xelatex' where id = $1", [project]);
  expect(await build(project)).toMatchObject({ status: 'succeeded', cached: false });
  await t.pool.query("update projects set compiler = 'lualatex' where id = $1", [project]);
  expect(await build(project)).toMatchObject({ status: 'succeeded', cached: false });
});

test('a build is up to date with a paper whose text it has, however the log has moved', async () => {
  const { project, main } = await paper('ieee-multifile');
  const intro = (await listFiles(t.pool, owner.id, project)).find(
    (f) => f.path === 'sections/intro.tex',
  )!;
  expect(await build(project)).toMatchObject({ status: 'succeeded', stale: false });

  // A file is opened in the editor for the first time. Nothing is typed: the paper is the
  // paper that was built.
  await loadUpdates(t.pool, store, intro.id);
  expect((await latestBuilds(t.pool, owner.id, project)).latest).toMatchObject({ stale: false });
  // Nor do the checks before submitting say the paper has changed since it was built. They
  // did, and no build could put it right.
  const checks = await submissionChecks(t.pool, store, owner.id, project);
  expect(checks.findings.filter((f) => f.kind === 'build')).toEqual([]);

  // Something is typed and taken back. The log has moved; the text has not. The build that
  // follows is of the same text, and is up to date with it, not behind it for ever.
  await edit(main, (text) => text.insert(0, 'x'));
  await edit(main, (text) => text.delete(0, 1));
  const before = (await latestBuilds(t.pool, owner.id, project)).latest!;
  expect(before.stale).toBe(true);
  const after = await build(project);
  expect(after).toMatchObject({ status: 'succeeded', stale: false, revisionId: before.revisionId });
  // And nothing more is asked for: the pane beside the editor builds whenever it is behind.
  expect((await latestBuilds(t.pool, owner.id, project)).latest!.id).toBe(after.id);

  // A file is deleted and one with the same bytes is made under its name. The text is the
  // same, but the file is another one: the build is of a revision that knows it by its new id.
  await deleteFile(t.pool, store, owner.id, project, intro.id);
  const bytes = readFileSync(join(FIXTURES, 'ieee-multifile', 'sections/intro.tex'));
  const remade = await createFile(t.pool, store, owner.id, project, 'sections/intro.tex', bytes);
  const third = await build(project);
  expect(third).toMatchObject({ status: 'succeeded', stale: false, cached: true });
  expect(third.revisionId).not.toBe(after.revisionId);
  expect(await sourceToPdf(t.pool, store, owner.id, project, third.id, remade, 4)).toMatchObject({
    page: expect.any(Number),
  });
});

test('a build is behind a paper that has changed without anything being typed', async () => {
  const { project, main } = await paper('ieee-multifile');
  const table = (await listFiles(t.pool, owner.id, project)).find(
    (f) => f.path === 'tables/ablation.tex',
  )!;
  const intro = (await listFiles(t.pool, owner.id, project)).find(
    (f) => f.path === 'sections/intro.tex',
  )!;
  await createFile(t.pool, store, owner.id, project, 'figures/dot.png', Buffer.from([0, 1, 2]));
  const stale = async () => (await latestBuilds(t.pool, owner.id, project)).latest!.stale;
  expect(await build(project)).toMatchObject({ status: 'succeeded', stale: false });
  const seen: Record<string, boolean> = {};

  // A file that is not text is replaced whole, as a chart is when it is drawn again.
  await putFile(t.pool, store, project, 'figures/dot.png', Buffer.from([3, 4, 5]));
  seen.replaced = await stale();
  seen.thenBuilt = (await build(project)).stale;

  // Another file is made the one the paper is built from, and then the first one again.
  await setRootFile(t.pool, owner.id, project, intro.id);
  seen.otherRoot = await stale();
  await setRootFile(t.pool, owner.id, project, main);
  seen.rootBack = await stale();

  // A file is deleted.
  await deleteFile(t.pool, store, owner.id, project, table.id);
  seen.deleted = await stale();

  expect(seen).toEqual({
    replaced: true,
    thenBuilt: false,
    otherRoot: true,
    rootBack: false,
    deleted: true,
  });
});

test('two workers never build the same build, and build two papers side by side', async () => {
  const first = (await paper()).project;
  const second = (await paper()).project;
  // One build waiting, two workers reaching for it at the same moment: one gets it.
  await requestBuild(t.pool, owner.id, first);
  expect(
    (await Promise.all([buildNext(t.pool, store, image), buildNext(t.pool, store, image)])).sort(),
  ).toEqual([false, true]);
  expect((await t.pool.query('select 1 from builds where project_id = $1', [first])).rowCount).toBe(
    1,
  );
  // Two papers waiting: each worker takes one.
  await edit(
    (await listFiles(t.pool, owner.id, first)).find((f) => f.path === 'main.tex')!.id,
    (text) => text.insert(0, '% changed\n'),
  );
  await requestBuild(t.pool, owner.id, first);
  await requestBuild(t.pool, owner.id, second);
  expect(
    await Promise.all([buildNext(t.pool, store, image), buildNext(t.pool, store, image)]),
  ).toEqual([true, true]);
  for (const project of [first, second])
    expect((await latestBuilds(t.pool, owner.id, project)).latest).toMatchObject({
      status: 'succeeded',
      stale: false,
    });
}, 120_000);

test('a burst of requests is one build, and a paper cannot build without limit', async () => {
  const { project } = await paper();
  const ids = await Promise.all(
    Array.from({ length: 6 }, () => requestBuild(t.pool, owner.id, project)),
  );
  expect(new Set(ids).size).toBe(1);
  expect(
    (await t.pool.query('select count(*)::int as n from builds where project_id = $1', [project]))
      .rows[0].n,
  ).toBe(1);
  expect((await latestBuilds(t.pool, owner.id, project)).latest!.status).toBe('queued');
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect(await buildNext(t.pool, store, image)).toBe(false);

  await requestBuild(t.pool, owner.id, project, { perHour: 2 });
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect(await code(requestBuild(t.pool, owner.id, project, { perHour: 2 }))).toBe('conflict');
});

test('the number stored for each label is the one printed in the PDF', async () => {
  for (const name of ['ieee-multifile', 'article-basic']) {
    const { project } = await paper(name);
    const built = await build(project);
    expect(built.status, name).toBe('succeeded');
    const labels = await buildLabels(t.pool, owner.id, project, built.id);
    const text = pdfText(
      Buffer.from(await buildOutput(t.pool, store, owner.id, project, built.id, 'pdf')),
    );

    // Every "Section~\ref{x}" in the source reads "Section <number>" in the PDF.
    let checked = 0;
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.tex')) {
          const src = readFileSync(p, 'utf8');
          for (const ref of labelIndex(src).refs) {
            const word = /(\w+)~$/.exec(src.slice(0, ref.at))?.[1];
            if (!word) continue;
            const number = labels[ref.key]?.number;
            expect(number, `${name}: ${ref.key}`).toBeTruthy();
            const shown = ref.command === 'eqref' ? `(${number})` : number;
            // Followed by a space or punctuation, so that "Section 2" is not matched by "Section 21".
            const at = text.indexOf(`${word} ${shown}`);
            expect(at, `${name}: ${word} ${shown}`).toBeGreaterThanOrEqual(0);
            expect(text[at + `${word} ${shown}`.length], `${name}: ${word} ${shown}`).toMatch(
              /[ .,;:]/,
            );
            checked++;
          }
        }
      }
    };
    walk(join(FIXTURES, name));
    expect(checked, name).toBeGreaterThanOrEqual(4);
  }
  // The IEEE class numbers its sections in Roman numerals, and so do we.
  const ieee = await paper('ieee-multifile');
  const labels = await buildLabels(t.pool, owner.id, ieee.project, (await build(ieee.project)).id);
  expect(labels['sec:method']).toEqual({ number: 'II', page: '1' });
  expect(labels['eq:minimal'].number).toBe('2');
  expect(labels['tab:ablation'].number).toBe('I');
  // Only for people on the paper.
  const { latest } = await latestBuilds(t.pool, owner.id, ieee.project);
  expect(await code(buildLabels(t.pool, outsider.id, ieee.project, latest!.id))).toBe('not_found');
  const other = await paper();
  expect(await code(buildLabels(t.pool, owner.id, other.project, latest!.id))).toBe('not_found');
}, 240_000);

test('a broken paper reports where, and the last good PDF is still there', async () => {
  const { project, main } = await paper();
  const good = await build(project);
  await edit(main, (text) =>
    text.insert(text.toString().indexOf('Collaborative'), '\\nosuchmacro '),
  );
  const bad = await build(project);
  expect(bad).toMatchObject({ status: 'failed', hasPdf: false });
  expect(bad.diagnostics).toContainEqual({
    severity: 'error',
    file: 'main.tex',
    line: 21,
    message: 'Undefined control sequence.',
  });
  const { latest, lastGood } = await latestBuilds(t.pool, owner.id, project);
  expect(latest!.id).toBe(bad.id);
  expect(lastGood).toMatchObject({ id: good.id, hasPdf: true, stale: true });
  expect(await code(buildOutput(t.pool, store, owner.id, project, bad.id, 'pdf'))).toBe(
    'not_found',
  );
  // The same broken text fails from the cache too.
  expect(await build(project)).toMatchObject({ status: 'failed', cached: true });
});

test('a worker that dies gives its build back', async () => {
  const { project } = await paper();
  const id = await requestBuild(t.pool, owner.id, project);
  // A worker takes the build and then vanishes without finishing.
  const dying = new pg.Client({ connectionString: t.url });
  await dying.connect();
  await dying.query('begin');
  const taken = await dying.query(
    "select id from builds where status = 'queued' for update skip locked",
  );
  expect(taken.rows.map((r) => r.id)).toEqual([id]);
  // While it holds the build, nobody else starts it.
  expect(await buildNext(t.pool, store, image)).toBe(false);
  await dying.end();
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect((await latestBuilds(t.pool, owner.id, project)).latest).toMatchObject({
    id,
    status: 'succeeded',
  });
});

test('builds and their outputs are only for people on the paper', async () => {
  const { project } = await paper();
  const mine = await build(project);
  const { token } = await invite(t.pool, owner.id, project, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  // A viewer may read the PDF but not start builds.
  expect(
    (await buildOutput(t.pool, store, viewer.id, project, mine.id, 'pdf')).length,
  ).toBeGreaterThan(1000);
  expect(await code(requestBuild(t.pool, viewer.id, project))).toBe('permission_denied');

  for (const what of ['pdf', 'log', 'synctex'] as const)
    expect(await code(buildOutput(t.pool, store, outsider.id, project, mine.id, what)), what).toBe(
      'not_found',
    );
  expect(await code(latestBuilds(t.pool, outsider.id, project))).toBe('not_found');
  expect(await code(requestBuild(t.pool, outsider.id, project))).toBe('not_found');

  // A build cannot be reached through another paper, even by someone on both.
  const other = await paper();
  expect(await code(buildOutput(t.pool, store, owner.id, other.project, mine.id, 'pdf'))).toBe(
    'not_found',
  );
  const sneaky = 'pdf_digest from builds; drop table builds; --' as 'pdf';
  expect(await code(buildOutput(t.pool, store, owner.id, project, mine.id, sneaky))).toBe(
    'not_found',
  );
  // And one paper's cache never serves another: the same files in a new paper are built afresh.
  expect((await build(other.project)).cached).toBe(false);
});

test('a build says where each line is in its PDF, and which line made each place', async () => {
  const { project } = await paper('ieee-multifile');
  const first = await build(project);
  const files = await listFiles(t.pool, owner.id, project);
  const to = (file: string, line: number) =>
    sourceToPdf(t.pool, store, owner.id, project, first.id, file, line);
  const from = (page: number, x: number, y: number) =>
    pdfToSource(t.pool, store, owner.id, project, first.id, page, x, y);

  // Every line of the paper's prose that put something in the PDF is found again from where
  // it was put. (A handful of lines put nothing of their own there: \begin{tabular} and such.)
  let asked = 0;
  let back = 0;
  for (const f of files.filter((x) => /^(sections|tables)\//.test(x.path))) {
    const lines = readFileSync(join(FIXTURES, 'ieee-multifile', f.path), 'utf8').split('\n');
    for (let n = 1; n <= lines.length; n++) {
      const place = await to(f.id, n);
      if (place.line !== n) continue;
      asked++;
      expect(place.page).toBe(1);
      const found = await from(place.page, place.x + 1, place.y + place.height * 0.7).catch(
        () => null,
      );
      if (found?.fileId === f.id && Math.abs(found.line - n) <= 1) back++;
    }
  }
  expect(asked).toBeGreaterThan(40);
  expect(back / asked).toBeGreaterThan(0.9);

  // The second column is told from the first: the results are there, the introduction is not.
  const intro = files.find((f) => f.path === 'sections/intro.tex')!;
  const results = files.find((f) => f.path === 'sections/results.tex')!;
  const left = await to(intro.id, 4);
  const right = await to(results.id, 4);
  expect(right.x - left.x).toBeGreaterThan(200);
  expect(await from(1, right.x + 20, right.y + 6)).toMatchObject({
    fileId: results.id,
    path: 'sections/results.tex',
  });

  // What cannot be answered is refused, and nobody outside the paper is answered at all.
  expect(await code(to(intro.id, 0))).toBe('invalid_input');
  expect(await code(to(outsider.id, 3))).toBe('not_found');
  expect(await code(from(9, 100, 100))).toBe('not_found');
  expect(await code(from(1, Number.NaN, 100))).toBe('invalid_input');
  expect(await code(sourceToPdf(t.pool, store, outsider.id, project, first.id, intro.id, 4))).toBe(
    'not_found',
  );
  expect(await code(pdfToSource(t.pool, store, outsider.id, project, first.id, 1, 100, 100))).toBe(
    'not_found',
  );
  // Not through another paper either.
  const other = await paper();
  expect(
    await code(sourceToPdf(t.pool, store, owner.id, other.project, first.id, intro.id, 4)),
  ).toBe('not_found');
}, 180_000);
