// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type * as Y from 'yjs';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { acceptInvitation, getProject, invite } from './projects.ts';
import {
  diffRevisions,
  exportRevision,
  listRevisions,
  olderAutoRevisions,
  REVISIONS_SHOWN,
  renameFile,
  lastRestore,
  restoreRevision,
  revisionPdf,
  saveRevision,
} from './revisions.ts';
import { editFile } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
const MAIN =
  '\\documentclass{article}\n\\input{body}\n\\begin{document}\nHello.\nSecond line.\n\\end{document}\n';
const BODY = '% body\n\\newcommand{\\x}{x}\n';
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

async function paper() {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: 'body.tex', bytes: Buffer.from(BODY) },
    { path: 'fig.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Revisions');
  const { token } = await invite(t.pool, owner.id, project.id, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  const files = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  return { id: project.id, main: files['main.tex'], body: files['body.tex'] };
}
const edit = (file: string, change: (text: Y.Text) => void) =>
  editFile(t.pool, store, file, owner.id, change);
const replace = (file: string, from: string, to: string) =>
  edit(file, (text) => {
    const at = text.toString().indexOf(from);
    text.delete(at, from.length);
    text.insert(at, to);
  });
const files = async (zip: Uint8Array) =>
  Object.fromEntries(
    (await readZip(zip)).entries.map((e) => [e.path, Buffer.from(e.bytes).toString('latin1')]),
  );
function manifestOf(zip: Uint8Array) {
  const file = join(mkdtempSync(join(tmpdir(), 'paperweave-test-')), 'revision.zip');
  writeFileSync(file, zip);
  return JSON.parse(
    execFileSync('unzip', ['-p', file, 'paperweave-toolchain.json'], { encoding: 'utf8' }),
  );
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test('revisions are cut when something changed, numbered in order, and can be named', async () => {
  const p = await paper();
  await exportZip(t.pool, store, owner.id, p.id);
  await exportZip(t.pool, store, owner.id, p.id);
  // Two downloads of the same text are one revision.
  expect((await listRevisions(t.pool, owner.id, p.id)).map((r) => [r.number, r.kind])).toEqual([
    [1, 'auto'],
  ]);

  const named = await saveRevision(t.pool, store, owner.id, p.id, '  Submitted to the workshop ');
  await replace(p.main, 'Hello.', 'Hello, world.');
  await exportZip(t.pool, store, owner.id, p.id);
  const all = await listRevisions(t.pool, owner.id, p.id);
  expect(all.map((r) => [r.number, r.kind, r.name])).toEqual([
    [3, 'auto', null],
    [2, 'named', 'Submitted to the workshop'],
    [1, 'auto', null],
  ]);
  expect(all[1]).toMatchObject({ id: named.id, createdBy: 'owner@example.org', hasPdf: false });

  // The button pressed twice: the same paper under the same name is the same revision. Under
  // another name, or once the paper has changed, it is a new one.
  const once = await saveRevision(t.pool, store, owner.id, p.id, 'Camera ready');
  const twice = await saveRevision(t.pool, store, owner.id, p.id, 'Camera ready');
  expect(twice).toEqual(once);
  const renamed = await saveRevision(t.pool, store, owner.id, p.id, 'Camera ready, really');
  expect(renamed.number).toBe(once.number + 1);
  await replace(p.main, 'Hello, world.', 'Hello again.');
  const later = await saveRevision(t.pool, store, owner.id, p.id, 'Camera ready, really');
  expect(later.number).toBe(renamed.number + 1);

  expect(await code(saveRevision(t.pool, store, owner.id, p.id, '   '))).toBe('invalid_input');
  expect(await code(saveRevision(t.pool, store, viewer.id, p.id, 'x'))).toBe('permission_denied');
  expect(await code(saveRevision(t.pool, store, outsider.id, p.id, 'x'))).toBe('not_found');
  expect(await code(listRevisions(t.pool, outsider.id, p.id))).toBe('not_found');
});

test('a long history is listed a part at a time, and what people named is always there', async () => {
  const p = await paper();
  const named = await saveRevision(t.pool, store, owner.id, p.id, 'Sent to the workshop');
  expect(named.number).toBe(1);
  // A paper being written gets a revision at every build. Here: 120 of them, made directly.
  await t.pool.query(
    `insert into revisions (project_id, number, kind, root, compiler, content_key)
     select $1, g, 'auto', 'main.tex', 'pdflatex', md5(g::text) from generate_series(2, 121) g`,
    [p.id],
  );
  const numbers = (list: { number: number }[]) => list.map((r) => r.number);
  const range = (from: number, to: number) =>
    Array.from({ length: from - to + 1 }, (_, i) => from - i);

  // All of them, when no limit is asked for.
  expect(numbers(await listRevisions(t.pool, owner.id, p.id))).toEqual(range(121, 1));
  // The newest fifty automatic ones, and the named one although it is the oldest of all.
  const first = await listRevisions(t.pool, owner.id, p.id, { autos: REVISIONS_SHOWN });
  expect(numbers(first)).toEqual([...range(121, 72), 1]);
  expect(await olderAutoRevisions(t.pool, owner.id, p.id, 72)).toBe(70);
  // The ones before those, the same way, to the end.
  const second = await listRevisions(t.pool, owner.id, p.id, {
    autos: REVISIONS_SHOWN,
    before: 72,
  });
  expect(numbers(second)).toEqual([...range(71, 22), 1]);
  const last = await listRevisions(t.pool, owner.id, p.id, { autos: REVISIONS_SHOWN, before: 22 });
  expect(numbers(last)).toEqual(range(21, 1));
  expect(await olderAutoRevisions(t.pool, owner.id, p.id, 2)).toBe(0);
  // Only for people on the paper.
  expect(await code(olderAutoRevisions(t.pool, outsider.id, p.id, 72))).toBe('not_found');
});

test('a revision never changes, and its export can say how to rebuild it', async () => {
  const p = await paper();
  const first = await saveRevision(t.pool, store, owner.id, p.id, 'First');
  await replace(p.main, 'Hello.', 'Changed since.');
  await renameFile(t.pool, owner.id, p.id, p.body, 'parts/body.tex');

  const old = await exportRevision(t.pool, store, owner.id, p.id, first.id, true);
  expect(old).toMatchObject({ paper: 'Revisions', number: 1 });
  const got = await files(old.zip);
  expect(got['main.tex']).toBe(MAIN);
  expect(got['body.tex']).toBe(BODY);
  expect(got['parts/body.tex']).toBeUndefined();
  // (Read with the system unzip: our own reader leaves out files a paper does not use.)
  const manifest = manifestOf(old.zip);
  expect(manifest).toMatchObject({
    revision: 1,
    root: 'main.tex',
    compiler: 'pdflatex',
    image: null,
  });
  expect(manifest.command).toBe(
    `SOURCE_DATE_EPOCH=${manifest.sourceDateEpoch} latexmk -norc -pdf -no-shell-escape -interaction=nonstopmode main.tex`,
  );
  expect(Object.keys(manifest.files).sort()).toEqual(['body.tex', 'fig.png', 'main.tex']);
  // Without the manifest, the archive is the paper's files and nothing else.
  expect(
    Object.keys(
      await files((await exportRevision(t.pool, store, owner.id, p.id, first.id)).zip),
    ).sort(),
  ).toEqual(['body.tex', 'fig.png', 'main.tex']);
  // The live paper has moved on.
  expect((await files(await exportZip(t.pool, store, owner.id, p.id)))['main.tex']).toContain(
    'Changed since.',
  );

  expect(await code(exportRevision(t.pool, store, viewer.id, p.id, first.id))).toBe(
    'permission_denied',
  );
  expect(await code(exportRevision(t.pool, store, outsider.id, p.id, first.id))).toBe('not_found');
  expect(await code(revisionPdf(t.pool, store, owner.id, p.id, first.id))).toBe('not_found');
  // A revision cannot be reached through another paper.
  const other = await paper();
  expect(await code(exportRevision(t.pool, store, owner.id, other.id, first.id))).toBe('not_found');
});

test('comparing two revisions shows changed lines, renames and nothing else', async () => {
  const p = await paper();
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
  await replace(p.main, 'Second line.', 'A better second line.\nAnd a third.');
  await renameFile(t.pool, owner.id, p.id, p.body, 'parts/body.tex');
  const b = await saveRevision(t.pool, store, owner.id, p.id, 'B');

  const diff = await diffRevisions(t.pool, store, viewer.id, p.id, a.id, b.id);
  expect(diff).toMatchObject({ from: 1, to: 2 });
  expect(diff.files.map((f) => [f.path, f.status, f.was])).toEqual([
    ['main.tex', 'changed', undefined],
    ['parts/body.tex', 'renamed', 'body.tex'],
  ]);
  expect(diff.files[0].lines!.filter((l) => l.op !== ' ')).toEqual([
    { op: '-', text: 'Second line.' },
    { op: '+', text: 'A better second line.' },
    { op: '+', text: 'And a third.' },
  ]);
  expect(await code(diffRevisions(t.pool, store, outsider.id, p.id, a.id, b.id))).toBe('not_found');
});

test('restoring puts the paper back as a new revision and erases nothing', async () => {
  const p = await paper();
  const good = await saveRevision(t.pool, store, owner.id, p.id, 'Good');
  await replace(p.main, 'Hello.', 'Something we regret.');
  await replace(p.body, '% body', '% body, also regretted');
  await renameFile(t.pool, owner.id, p.id, p.body, 'moved.tex');
  await saveRevision(t.pool, store, owner.id, p.id, 'Regretted');

  expect(await code(restoreRevision(t.pool, store, viewer.id, p.id, good.id))).toBe(
    'permission_denied',
  );
  expect(await lastRestore(t.pool, viewer.id, p.main)).toBe(0);
  const restored = await restoreRevision(t.pool, store, owner.id, p.id, good.id);
  // Anyone on the paper can see that it was restored, and when; nobody else can.
  expect(await lastRestore(t.pool, viewer.id, p.main)).toBe(restored.number);
  expect(await code(lastRestore(t.pool, outsider.id, p.main))).toBe('not_found');
  const now = await files(await exportZip(t.pool, store, owner.id, p.id));
  expect(now['main.tex']).toBe(MAIN);
  expect(now['body.tex']).toBe(BODY);
  expect(now['moved.tex']).toBeUndefined();
  expect((await getProject(t.pool, owner.id, p.id)).root).toBe('main.tex');

  const all = await listRevisions(t.pool, owner.id, p.id);
  expect(all.map((r) => [r.number, r.kind, r.name, r.restoredFrom])).toEqual([
    [3, 'restore', null, 1],
    [2, 'named', 'Regretted', null],
    [1, 'named', 'Good', null],
  ]);
  expect(all[0].id).toBe(restored.id);
  // "Restore" pressed twice: the paper is already as it was put back, and that is the same
  // revision, not another one like it.
  expect(await restoreRevision(t.pool, store, owner.id, p.id, good.id)).toEqual(restored);
  expect(await listRevisions(t.pool, owner.id, p.id)).toHaveLength(3);
  // The regretted revision is still there to go back to.
  const regretted = await files(
    (await exportRevision(t.pool, store, owner.id, p.id, all[1].id)).zip,
  );
  expect(regretted['main.tex']).toContain('Something we regret.');
  expect(regretted['moved.tex']).toContain('also regretted');
});

test('a restore first keeps the paper as it stood, unsaved edits included', async () => {
  const p = await paper();
  const good = await saveRevision(t.pool, store, owner.id, p.id, 'Good');
  // Typed since the last revision, and in no revision yet.
  await replace(p.main, 'Hello.', 'Typed a moment ago.');
  await restoreRevision(t.pool, store, owner.id, p.id, good.id);
  expect((await files(await exportZip(t.pool, store, owner.id, p.id)))['main.tex']).toBe(MAIN);

  const all = await listRevisions(t.pool, owner.id, p.id);
  expect(all.map((r) => [r.number, r.kind, r.restoredFrom])).toEqual([
    [3, 'restore', 1],
    [2, 'auto', null],
    [1, 'named', null],
  ]);
  const kept = await files((await exportRevision(t.pool, store, owner.id, p.id, all[1].id)).zip);
  expect(kept['main.tex']).toContain('Typed a moment ago.');
});

test('saving a revision does not hold up editing while the store is slow', async () => {
  const p = await paper();
  await replace(p.main, 'Hello.', 'Edited once.');
  // A store that does not answer a write until it is let.
  let letGo!: () => void;
  const held = new Promise<void>((r) => (letGo = r));
  let asked = 0;
  const slow = {
    get: store.get,
    async put(bytes: Uint8Array) {
      asked++;
      await held;
      return store.put(bytes);
    },
  };
  const saving = saveRevision(t.pool, slow, owner.id, p.id, 'While the store was slow');
  await expect.poll(() => asked).toBe(1);
  // The store has still not answered. If saving held the file while it waited, this edit
  // would wait too, and never return; the editor gives a structural edit eight seconds.
  await replace(p.main, 'Edited once.', 'Edited twice.');
  letGo();
  const made = await saving;
  // The revision is the paper as it stood when it was cut, which is after that edit: what was
  // stored ahead of time was out of date, and was not used.
  const kept = await files((await exportRevision(t.pool, store, owner.id, p.id, made.id)).zip);
  expect(kept['main.tex']).toContain('Edited twice.');
  expect(asked).toBe(2);
});

test('a file can be renamed to a usable name and keeps its identity', async () => {
  const p = await paper();
  await renameFile(t.pool, owner.id, p.id, p.main, 'paper.tex');
  const listed = await listFiles(t.pool, owner.id, p.id);
  expect(listed.find((f) => f.id === p.main)!.path).toBe('paper.tex');
  // The root file is still the root under its new name.
  expect((await getProject(t.pool, owner.id, p.id)).root).toBe('paper.tex');

  expect(await code(renameFile(t.pool, owner.id, p.id, p.body, 'paper.tex'))).toBe('conflict');
  for (const bad of [
    '../escape.tex',
    '/abs.tex',
    'a//b.tex',
    'run.exe',
    '',
    'dir/',
    'x\u0000.tex',
    'a\\b.tex',
    'latexmkrc',
  ])
    expect(await code(renameFile(t.pool, owner.id, p.id, p.body, bad)), JSON.stringify(bad)).toBe(
      'invalid_input',
    );
  expect(await code(renameFile(t.pool, viewer.id, p.id, p.body, 'ok.tex'))).toBe(
    'permission_denied',
  );
  expect(await code(renameFile(t.pool, outsider.id, p.id, p.body, 'ok.tex'))).toBe('not_found');
  // A file of another paper cannot be renamed through this one.
  const other = await paper();
  expect(await code(renameFile(t.pool, owner.id, p.id, other.body, 'ok.tex'))).toBe('not_found');
});
