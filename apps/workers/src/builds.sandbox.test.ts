// Needs Docker, the TeX image and the services in infra/compose.yaml. Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  acceptInvitation,
  appendUpdate,
  blobStore,
  buildLabels,
  buildOutput,
  createFile,
  deleteFile,
  exportRevision,
  importReport,
  importZip,
  invite,
  latestBuilds,
  listFiles,
  loadUpdates,
  createProject,
  requestBuild,
  TEXT,
  writeZip,
  pdfToSource,
  putFile,
  readZip,
  renameFileAndReferences,
  replaceFile,
  setCompiler,
  setRootFile,
  sourceToPdf,
  submissionChecks,
} from '@paperweave/server';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { texText } from '../../../packages/latex/src/encoding.ts';
import { labelIndex } from '../../../packages/latex/src/labels.ts';
import { parseSyncTeX } from '../../../packages/latex/src/synctex.ts';
import { FIXTURES } from '../../../packages/latex/src/testutil.ts';
import { pdfText } from '../../../packages/server/src/pdftext.ts';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { buildNext, imageId, takeBuild } from './builder.ts';

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

test('a build is behind a paper whose text file was replaced without being typed in', async () => {
  const { project } = await paper();
  const bib = (await listFiles(t.pool, owner.id, project)).find((f) => f.path === 'refs.bib')!;
  const original = readFileSync(join(FIXTURES, 'article-basic', 'refs.bib'), 'utf8');
  const latest = async () => (await latestBuilds(t.pool, owner.id, project)).latest!;
  const headSeq = async () =>
    (await t.pool.query('select head_seq from files where id = $1', [bib.id])).rows[0].head_seq;
  const first = await build(project);
  expect(first.stale).toBe(false);

  // refs.bib is uploaded anew, and was never opened: its log is still empty.
  const added = `${original}\n@misc{added2026, title = {Added}, year = 2026}\n`;
  await replaceFile(t.pool, store, owner.id, project, 'refs.bib', Buffer.from(added));
  expect(await headSeq()).toBe('0');
  expect((await latest()).stale).toBe(true);

  // The checks before submitting do not offer the old revision.
  const checks = await submissionChecks(t.pool, store, owner.id, project);
  expect(checks.findings).toContainEqual(
    expect.objectContaining({
      kind: 'build',
      message: 'The paper has changed since it was last built.',
    }),
  );
  expect(checks).toMatchObject({ ready: false, revisionId: null });

  // The next build is of the new file, and the ZIP of its revision holds it.
  const second = await build(project);
  expect(second).toMatchObject({ stale: false, cached: false });
  expect(second.revisionId).not.toBe(first.revisionId);
  const { zip } = await exportRevision(t.pool, store, owner.id, project, second.revisionId!);
  const entry = (await readZip(zip)).entries.find((e) => e.path === 'refs.bib')!;
  expect(Buffer.from(entry.bytes).toString()).toContain('added2026');

  // Opened (the log has its first entry), then replaced by the same text with other line
  // endings: nothing was typed, and the file is still the upload.
  await loadUpdates(t.pool, store, bib.id);
  expect(await headSeq()).toBe('1');
  expect((await latest()).stale).toBe(false);
  await replaceFile(
    t.pool,
    store,
    owner.id,
    project,
    'refs.bib',
    Buffer.from(added.replace(/\n/g, '\r\n')),
  );
  expect(await headSeq()).toBe('1');
  expect((await latest()).stale).toBe(true);
  expect((await build(project)).stale).toBe(false);

  // The very bytes it already has are no change.
  await replaceFile(
    t.pool,
    store,
    owner.id,
    project,
    'refs.bib',
    Buffer.from(added.replace(/\n/g, '\r\n')),
  );
  expect((await latest()).stale).toBe(false);
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
    message: 'Undefined control sequence. LaTeX does not know \\nosuchmacro.',
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
  // Blank lines that only end a paragraph made nothing of their own, and no longer count.
  expect(asked).toBeGreaterThan(35);
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

// A two-column paper of wrapped paragraphs, each with a marker word on the second line of its
// text. The three paragraphs of the introduction are MARKERA to MARKERC; the method has more.
const paragraph = (m: string) =>
  `Para line one before the marker, with enough ordinary words to fill a column line here.\nThe word ${m} sits on the second line of this paragraph with more words after it to wrap.\nA third line closes the paragraph, nothing special about it at all, just filler text.\n`;
const INTRO = [
  '\\section{Introduction}',
  '',
  paragraph('MARKERA'),
  paragraph('MARKERB'),
  paragraph('MARKERC'),
].join('\n');
const METHOD = ['\\section{Method}', '', paragraph('MARKERD')].join('\n');
const MAIN = [
  '\\documentclass[twocolumn]{article}',
  '\\begin{document}',
  '\\input{sections/intro}',
  '\\input{sections/method}',
  '\\end{document}',
  '',
].join('\n');

test('a point in the PDF and a line of the text are carried across the edits made since the build', async () => {
  const [made] = await importZip(
    t.pool,
    store,
    owner.id,
    await writeZip([
      { path: 'main.tex', bytes: Buffer.from(MAIN) },
      { path: 'sections/intro.tex', bytes: Buffer.from(INTRO) },
      { path: 'sections/method.tex', bytes: Buffer.from(METHOD) },
    ]),
    'carried',
  );
  const project = made.id;
  const all = await listFiles(t.pool, owner.id, project);
  const intro = all.find((f) => f.path === 'sections/intro.tex')!;
  const method = all.find((f) => f.path === 'sections/method.tex')!;
  const text = async (file: string) => {
    const doc = new Y.Doc();
    for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
    return doc.getText(TEXT).toString();
  };
  const lineOf = (src: string, word: string) =>
    src.split('\n').findIndex((l) => l.includes(word)) + 1;
  const b = await build(project);
  expect(b.status).toBe('succeeded');
  const to = (file: string, line: number) =>
    sourceToPdf(t.pool, store, owner.id, project, b.id, file, line);
  const from = (page: number, x: number, y: number) =>
    pdfToSource(t.pool, store, owner.id, project, b.id, page, x, y);
  const sync = parseSyncTeX(
    texText(gunzipSync(await buildOutput(t.pool, store, owner.id, project, b.id, 'synctex'))),
  );
  const built = await text(intro.id);
  const click = (p: { x: number; y: number; height: number }) =>
    [p.x + 1, p.y + p.height * 0.7] as const;

  // On the build as it is: a click at the left edge of a wrapped line, before its first word, is
  // on that line of the text, not on the line the paragraph ends on.
  for (const m of ['MARKERA', 'MARKERB', 'MARKERC']) {
    const line = lineOf(built, m);
    const p = await to(intro.id, line);
    expect(p.moved).toBe(false);
    // The line of text the marker is in, and the one below it.
    const here = sync.records
      .filter((r) => r.box && r.page === p.page && r.w > 0 && r.h + r.d < 30)
      .filter((r) => p.x + 1 >= r.x && p.x + 1 <= r.x + r.w && Math.abs(r.y - p.y - 8) < 3)
      .sort((a, c) => a.w - c.w)[0];
    const below = sync.records
      .filter((r) => r.box && r.page === p.page && r.x === here.x && r.w === here.w)
      .find((r) => Math.abs(r.y - here.y - 12) < 1)!;
    expect(await from(p.page, below.x + 24, below.y - 2), m).toMatchObject({
      fileId: intro.id,
      line,
      moved: false,
    });
  }
  // A heading that begins a file is where its own line is, below the paragraph before it that
  // carries its tag, and a click there comes back to it.
  const c = await to(intro.id, lineOf(built, 'MARKERC'));
  const heading = await to(method.id, 1);
  expect(heading.page * 10_000 + heading.y).toBeGreaterThan(c.page * 10_000 + c.y);
  expect(await from(heading.page, heading.x + 1, heading.y + heading.height * 0.7)).toMatchObject({
    fileId: method.id,
    line: 1,
  });
  const a = await to(intro.id, lineOf(built, 'MARKERA'));
  const d = await to(method.id, lineOf(await text(method.id), 'MARKERD'));

  // Ten lines are added above, and nothing is built: the click is on MARKERC's line as it is now.
  await edit(intro.id, (tx) =>
    tx.insert(0, Array.from({ length: 10 }, (_, i) => `% inserted ${i}\n`).join('')),
  );
  const now = await text(intro.id);
  expect(lineOf(now, 'MARKERC')).toBe(lineOf(built, 'MARKERC') + 10);
  expect(await from(c.page, ...click(c))).toMatchObject({
    fileId: intro.id,
    line: lineOf(now, 'MARKERC'),
    moved: false,
  });
  // The other way: the line as it is now is where the build put the line it was.
  expect(await to(intro.id, lineOf(now, 'MARKERC'))).toEqual({ ...c, moved: false });
  // A line that was not there when it was built is the nearest place, and says so.
  expect(await to(intro.id, 3)).toMatchObject({ moved: true });

  // Its paragraph is deleted: the point is the nearest line left, and says so.
  const start = now.indexOf(paragraph('MARKERC'));
  await edit(intro.id, (tx) => tx.delete(start, paragraph('MARKERC').length));
  const after = await text(intro.id);
  expect(after).not.toContain('MARKERC');
  const gone = await from(c.page, ...click(c));
  expect(gone).toMatchObject({ fileId: intro.id, moved: true });
  expect(gone.line).toBeLessThanOrEqual(after.split('\n').length);

  // The file is renamed: the answer carries its path now, and the same id.
  await renameFileAndReferences(t.pool, store, owner.id, project, intro.id, 'sections/opening.tex');
  expect(await from(a.page, ...click(a))).toMatchObject({
    fileId: intro.id,
    path: 'sections/opening.tex',
  });
  expect(await to(intro.id, lineOf(await text(intro.id), 'MARKERA'))).toMatchObject({
    page: a.page,
  });

  // A file is deleted: what it made is refused, with the reason.
  await deleteFile(t.pool, store, owner.id, project, method.id);
  const refused = await from(d.page, ...click(d)).catch((e) => e);
  expect(refused).toMatchObject({
    code: 'not_found',
    message: 'That part of the PDF came from a file that is no longer in the paper.',
  });
}, 180_000);

// Papers as they come from elsewhere: imported as a ZIP, then built.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const BIB = '@book{k, author={A. Author}, title={A Book}, publisher={P}, year=2020}\n';
const BBL =
  '\\begin{thebibliography}{1}\n\\bibitem{k} A.~Author. \\newblock {\\em A Book}. \\newblock P, 2020.\n\\end{thebibliography}\n';
const tex = (body: string, pre = '') =>
  `\\documentclass{article}\n\\usepackage{graphicx}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`;
const cite = (bib: string) => `Hi \\cite{k}\n\\bibliographystyle{plain}\n\\bibliography{${bib}}`;

async function importAndBuild(files: Record<string, string | Buffer>, name = 'Imported') {
  const zip = await writeZip(
    Object.entries(files).map(([path, b]) => ({ path, bytes: Buffer.from(b) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, name);
  const built = await build(project.id);
  const text = built.hasPdf
    ? String(
        pdfText(
          Buffer.from(await buildOutput(t.pool, store, owner.id, project.id, built.id, 'pdf')),
        ),
      )
    : '';
  const errors = built.diagnostics.filter((d) => d.severity === 'error');
  return { project, built, text, errors };
}

test('a root in a folder, with figures and bibliography beside the folder, builds whole', async () => {
  const { project, built, text, errors } = await importAndBuild({
    'src/main.tex': tex(`${cite('../refs')} \\includegraphics{../figures/a}`),
    'figures/a.png': PNG,
    'refs.bib': BIB,
  });
  expect(errors).toEqual([]);
  expect(built).toMatchObject({ status: 'succeeded', hasPdf: true });
  expect(text).toContain('A Book');
  expect(project.name).toBe('Imported');
  expect((await listFiles(t.pool, owner.id, project.id)).map((f) => f.path)).toEqual([
    'figures/a.png',
    'refs.bib',
    'src/main.tex',
  ]);
});

test('an arXiv-shaped paper, a .bbl and no .bib, builds with its citations resolved', async () => {
  const { built, text, errors } = await importAndBuild({
    'main.tex': tex(cite('refs')),
    'main.bbl': BBL,
  });
  expect(errors).toEqual([]);
  expect(built).toMatchObject({ status: 'succeeded', hasPdf: true });
  expect(text).toContain('A Book');
  expect(text).not.toContain('?');
  expect(built.diagnostics.filter((d) => /undefined/.test(d.message))).toEqual([]);
});

test('a paper with a .tikz picture builds', async () => {
  const { built, errors } = await importAndBuild({
    'main.tex': tex('\\input{fig.tikz}', '\\usepackage{tikz}'),
    'fig.tikz': '\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}\n',
  });
  expect(errors).toEqual([]);
  expect(built).toMatchObject({ status: 'succeeded', hasPdf: true });
});

test.each(['my paper.tex', 'résumé (v2).tex'])(
  'a root named %s, with a bibliography, builds',
  async (root) => {
    const { project, built, text, errors } = await importAndBuild({
      [root]: tex(cite('refs')),
      'refs.bib': BIB,
    });
    expect(errors).toEqual([]);
    expect(built).toMatchObject({ status: 'succeeded', hasPdf: true });
    expect(text).toContain('A Book');
    expect((await importReport(t.pool, owner.id, project.id))!.root).toBe(root);
  },
);

// What TeX writes is the bytes of the sources it echoes: UTF-8 names and keys must come back whole.
test.each(['pdflatex', 'xelatex', 'lualatex'] as const)(
  'a file, label and citation with accents are found again in the log, labels and SyncTeX (%s)',
  async (compiler) => {
    const body = (extra: string) => ({
      'main.tex': tex(
        `\\section{A}\\label{sec:intro}\n\\input{sections/méthode}\nSee \\ref{sec:méthode}, \\cite{müller2020}.\n\\bibliographystyle{plain}\n\\bibliography{refs}`,
        compiler === 'pdflatex' ? '\\usepackage[T1]{fontenc}' : '',
      ),
      'sections/méthode.tex': `\\section{Méthode}\\label{sec:méthode}\nWords.\n${extra}`,
      'refs.bib':
        '@book{müller2020, author={A. Müller}, title={A Book}, publisher={P}, year=2020}\n',
    });
    const broken = await importAndBuild(body('\\nosuchmacro'), 'Accents broken');
    await setCompiler(t.pool, owner.id, broken.project.id, compiler);
    const bad = await build(broken.project.id);
    expect(bad.status).toBe('failed');
    expect(bad.diagnostics[0]).toMatchObject({
      severity: 'error',
      file: 'sections/méthode.tex',
      line: 3,
    });

    const good = await importAndBuild(body(''), 'Accents good');
    await setCompiler(t.pool, owner.id, good.project.id, compiler);
    const built = await build(good.project.id);
    expect(built).toMatchObject({ status: 'succeeded', hasPdf: true });
    const labels = await buildLabels(t.pool, owner.id, good.project.id, built.id);
    expect(labels['sec:méthode']).toMatchObject({ number: '2' });
    const file = (await listFiles(t.pool, owner.id, good.project.id)).find(
      (f) => f.path === 'sections/méthode.tex',
    )!;
    expect(
      await sourceToPdf(t.pool, store, owner.id, good.project.id, built.id, file.id, 2),
    ).toMatchObject({ page: 1 });
    const log = Buffer.from(
      await buildOutput(t.pool, store, owner.id, good.project.id, built.id, 'log'),
    );
    expect(log.toString('utf8')).toContain('sections/méthode.tex');
  },
  240_000,
);

test('a root whose name begins with a dash is a path to latexmk, not an option', async () => {
  // Beside its folder too: latexmk is started there, and still given "./-x.tex".
  for (const root of ['-x.tex', 'sub/-x.tex']) {
    const { built, errors } = await importAndBuild({ [root]: tex('Dashed.'), 'other.txt': 'x' });
    expect(errors, root).toEqual([]);
    expect(built, root).toMatchObject({ status: 'succeeded', hasPdf: true });
  }
});

test('a paper built with the wrong engine fails, and builds once the compiler is changed', async () => {
  // The magic comment holds the guess at pdflatex, though the paper needs fontspec.
  const { project, built } = await importAndBuild({
    'main.tex':
      '% !TEX program = pdflatex\n\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nEngine test.\n\\end{document}\n',
  });
  expect(built.status).toBe('failed');
  await setCompiler(t.pool, owner.id, project.id, 'xelatex');
  const fixed = await build(project.id);
  expect(fixed).toMatchObject({ status: 'succeeded', hasPdf: true });
  const { zip } = await exportRevision(
    t.pool,
    store,
    owner.id,
    project.id,
    fixed.revisionId!,
    true,
  );
  const file = join(mkdtempSync(join(tmpdir(), 'paperweave-test-')), 'revision.zip');
  writeFileSync(file, zip);
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', file, 'paperweave-toolchain.json'], { encoding: 'utf8' }),
  );
  expect(manifest.compiler).toBe('xelatex');
});

test('a paper with a long but valid file name still builds', async () => {
  const { project, main } = await paper();
  // 80 CJK characters are 240 bytes: under the 255 bytes a file name may have on disk.
  const name = `${'漢'.repeat(80)}.tex`;
  await createFile(t.pool, store, owner.id, project, name, Buffer.from('Extra words.\n'));
  await edit(main, (text) =>
    text.insert(text.toString().indexOf('\\end{document}'), `\\input{${name}}\n`),
  );
  const done = await build(project);
  expect(done).toMatchObject({ status: 'succeeded', hasPdf: true });
});

test('the next build taken is the one whose requester has had the fewest done, not the oldest', async () => {
  const a = await t.signIn('fair-a@example.org');
  const b = await t.signIn('fair-b@example.org');
  const mine = await Promise.all(
    Array.from({ length: 5 }, (_, i) => createProject(t.pool, a.id, `A${i}`)),
  );
  const theirs = await createProject(t.pool, b.id, 'B');
  // Five of A's, queued first (older), then one of B's.
  for (const p of mine)
    await t.pool.query('insert into builds (project_id, requested_by) values ($1, $2)', [
      p.id,
      a.id,
    ]);
  await t.pool.query('insert into builds (project_id, requested_by) values ($1, $2)', [
    theirs.id,
    b.id,
  ]);
  const first = await takeBuild(t.pool);
  expect(first!.requested_by).toBe(a.id);
  await t.pool.query("update builds set status = 'succeeded', finished_at = now() where id = $1", [
    first!.id,
  ]);
  // A has had one built now, B none: B's build is next, ahead of A's four older ones.
  const second = await takeBuild(t.pool);
  expect(second!.requested_by).toBe(b.id);
  await t.pool.query("update builds set status = 'succeeded', finished_at = now() where id = $1", [
    second!.id,
  ]);
  expect((await takeBuild(t.pool))!.requested_by).toBe(a.id);
});
