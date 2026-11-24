// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { LATEXMK_RULES } from '@paperweave/latex';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { createFile, deleteFile, replaceFile } from './files.ts';
import { approveDataset, datasetProposal } from './data.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { acceptInvitation, getProject, invite } from './projects.ts';
import { acceptProposal, listProposals, propose, undoAccept } from './proposals.ts';
import {
  diffRevisions,
  exportRevision,
  exportRevisionStream,
  unusedInRevision,
  listRevisions,
  olderAutoRevisions,
  REVISIONS_SHOWN,
  renameFile,
  lastRestore,
  lastRestoreNote,
  restoreEdits,
  cutRevision,
  restoreNote,
  restoreThatRemoved,
  restoreRevision,
  revisionOfNow,
  revisionPdf,
  saveRevision,
} from './revisions.ts';
import { appendUpdate, editFile, loadUpdates, TEXT } from './sync.ts';
import { diffLines } from './textdiff.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { listThreads, startThread } from './threads.ts';

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

test('a file says how large it is now, as of the newest revision of the paper', async () => {
  const p = await paper();
  const size = async () =>
    (await listFiles(t.pool, owner.id, p.id)).find((f) => f.path === 'body.tex')!.size;
  expect(await size()).toBe(BODY.length);
  // Written to since it was added. Its size is worked out when a revision is cut, which every
  // build does, and stands until then.
  await edit(p.body, (text) => text.insert(text.length, '% more, with an accent: é\n'));
  expect(await size()).toBe(BODY.length);
  await saveRevision(t.pool, store, owner.id, p.id, 'Sized');
  expect(await size()).toBe(Buffer.byteLength(BODY + '% more, with an accent: é\n'));
  // Saved again with nothing changed: no new revision, and the size stands.
  await saveRevision(t.pool, store, owner.id, p.id, 'Sized');
  expect(await size()).toBe(Buffer.byteLength(BODY + '% more, with an accent: é\n'));
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
    `SOURCE_DATE_EPOCH=${manifest.sourceDateEpoch} FORCE_SOURCE_DATE=1 latexmk -norc -cd -pdf -no-shell-escape -bibtex-cond -interaction=nonstopmode -e '${LATEXMK_RULES}' main.tex`,
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

test('the paper as it is now is the latest revision, or a new one when something changed since', async () => {
  const p = await paper();
  const named = await saveRevision(t.pool, store, owner.id, p.id, 'Sent out');
  // Nothing has changed: the named revision is the paper as it is now, and no other is made.
  expect((await revisionOfNow(t.pool, store, owner.id, p.id)).id).toBe(named.id);

  await replace(p.main, 'Hello.', 'Hello, world.');
  const now = await revisionOfNow(t.pool, store, owner.id, p.id);
  expect(now.number).toBe(named.number + 1);
  // Asked again with nothing typed between: the same one.
  expect((await revisionOfNow(t.pool, store, owner.id, p.id)).id).toBe(now.id);
  expect(
    (await listRevisions(t.pool, owner.id, p.id)).map((r) => [r.id, r.kind, r.createdBy]),
  ).toEqual([
    [now.id, 'auto', 'owner@example.org'],
    [named.id, 'named', 'owner@example.org'],
  ]);
  // What a comparison from the named one up to now then shows, to anyone on the paper.
  const diff = await diffRevisions(t.pool, store, viewer.id, p.id, named.id, now.id);
  expect(diff).toMatchObject({ from: named.number, to: now.number });
  expect(diff.files.map((f) => [f.path, f.status])).toEqual([['main.tex', 'changed']]);

  // Only for those who may make revisions, and nothing is made for anyone else.
  await replace(p.main, 'Hello, world.', 'Hello again.');
  expect(await code(revisionOfNow(t.pool, store, viewer.id, p.id))).toBe('permission_denied');
  expect(await code(revisionOfNow(t.pool, store, outsider.id, p.id))).toBe('not_found');
  expect(await listRevisions(t.pool, owner.id, p.id)).toHaveLength(2);
});

test('a text file that changed too much to compare line by line is marked too large', async () => {
  const p = await paper();
  const block = (word: string) => Array.from({ length: 2100 }, (_, i) => `${word} ${i}`).join('\n');
  await replace(p.main, 'Second line.', block('old'));
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'Old');
  await replace(p.main, block('old'), block('new'));
  const b = await saveRevision(t.pool, store, owner.id, p.id, 'New');

  const diff = await diffRevisions(t.pool, store, viewer.id, p.id, a.id, b.id);
  expect(diff.files).toHaveLength(1);
  expect(diff.files[0]).toMatchObject({
    path: 'main.tex',
    status: 'changed',
    lines: null,
    tooLarge: true,
  });
});

test('a few changes far apart in a long file are compared line by line', async () => {
  const p = await paper();
  const block = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  await replace(p.main, 'Second line.', block);
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'Long');
  await replace(p.main, 'line 7\n', 'line seven\n');
  await replace(p.main, 'line 4990\n', '');
  const b = await saveRevision(t.pool, store, owner.id, p.id, 'Edited');

  // 4,982 lines lie between the two changes: more than the table of the line diff takes.
  const x = MAIN.replace('Second line.', block);
  const y = x.replace('line 7\n', 'line seven\n').replace('line 4990\n', '');
  expect(diffLines(x, y)).toBeNull();
  const diff = await diffRevisions(t.pool, store, viewer.id, p.id, a.id, b.id);
  expect(diff.files).toHaveLength(1);
  expect(diff.files[0]).toMatchObject({ path: 'main.tex', status: 'changed' });
  expect(diff.files[0].tooLarge).toBeUndefined();
  expect(diff.files[0].lines!.filter((l) => l.op !== ' ')).toEqual([
    { op: '-', text: 'line 7' },
    { op: '+', text: 'line seven' },
    { op: '-', text: 'line 4990' },
  ]);
  expect(diff.files[0].lines).toHaveLength(MAIN.split('\n').length - 1 + 5000 + 1);
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

test('what the editors of a paper are told of a restore: who, to what, and the revision that keeps the paper as it was', async () => {
  const p = await paper();
  expect(await lastRestoreNote(t.pool, viewer.id, p.main)).toBeNull();
  expect(await restoreNote(t.pool, p.id)).toBeNull();
  const good = await saveRevision(t.pool, store, owner.id, p.id, 'Good');
  // Typed since, and in no revision yet: the restore keeps it as a revision of its own.
  await replace(p.main, 'Hello.', 'Typed a moment ago.');
  const restored = await restoreRevision(t.pool, store, owner.id, p.id, good.id);
  const all = await listRevisions(t.pool, owner.id, p.id);
  const note = await lastRestoreNote(t.pool, viewer.id, p.main);
  expect(note).toEqual({
    id: restored.id,
    number: 3,
    from: 1,
    fromName: 'Good',
    by: 'owner@example.org',
    at: new Date(all[0].createdAt).toISOString(),
    kept: { id: all[1].id, number: 2 },
  });
  // The kept revision is the paper as it was: the comparison with the restore shows what went.
  const kept = await files(
    (await exportRevision(t.pool, store, owner.id, p.id, note!.kept!.id)).zip,
  );
  expect(kept['main.tex']).toContain('Typed a moment ago.');
  // By number, as the sync server asks; a number that is not a restore is nothing.
  expect(await restoreNote(t.pool, p.id, 3)).toEqual(note);
  expect(await restoreNote(t.pool, p.id, 2)).toBeNull();
  expect(await restoreNote(t.pool, p.id, 9)).toBeNull();
  // Only for someone on the paper.
  expect(await code(lastRestoreNote(t.pool, outsider.id, p.main))).toBe('not_found');
  // Pressed again with nothing changed: the same restore, and the same paper kept.
  await restoreRevision(t.pool, store, owner.id, p.id, good.id);
  expect(await lastRestoreNote(t.pool, viewer.id, p.main)).toEqual(note);
  // A later restore of a revision without a name.
  await replace(p.main, 'Hello.', 'Typed again.');
  const again = await restoreRevision(t.pool, store, owner.id, p.id, all[1].id);
  expect(await restoreNote(t.pool, p.id)).toMatchObject({
    number: again.number,
    from: 2,
    fromName: null,
    kept: { number: again.number - 1 },
  });
});

test('a file a restore takes out is known to have gone by that restore, and a deleted one is not', async () => {
  const p = await paper();
  const good = await saveRevision(t.pool, store, owner.id, p.id, 'Good');
  const notes = await createFile(t.pool, store, owner.id, p.id, 'notes.tex');
  const other = await createFile(t.pool, store, owner.id, p.id, 'other.tex');
  // In the paper: nothing took it out.
  expect(await restoreThatRemoved(t.pool, p.id, notes)).toBeNull();
  // Deleted by hand, with a restore before it and one after: neither took it out.
  await restoreRevision(t.pool, store, owner.id, p.id, good.id);
  const back = (await listRevisions(t.pool, owner.id, p.id))[1];
  await restoreRevision(t.pool, store, owner.id, p.id, back.id);
  await deleteFile(t.pool, store, owner.id, p.id, other);
  const restored = await restoreRevision(t.pool, store, owner.id, p.id, good.id);
  expect(await restoreThatRemoved(t.pool, p.id, other)).toBeNull();
  // The restore of a revision without the file took it out: that restore, with its details.
  expect(await restoreThatRemoved(t.pool, p.id, notes)).toEqual(
    await restoreNote(t.pool, p.id, restored.number),
  );
  expect((await restoreThatRemoved(t.pool, p.id, notes))!.kept).not.toBeNull();
  // A file the restore kept, and a file of another paper asked about under this one.
  expect(await restoreThatRemoved(t.pool, p.id, p.main)).toBeNull();
  const elsewhere = await paper();
  expect(await restoreThatRemoved(t.pool, elsewhere.id, notes)).toBeNull();
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
    ...store,
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

// Restoring replaces each changed stretch on its own, so what is anchored elsewhere stays put.
const PARAS = [
  'P1 alpha foxes jump over fences.',
  'P2 beta cats sleep all day.',
  'P3 gamma wolves howl loudly at night.',
  'P4 delta owls watch the dark.',
  'P5 epsilon bears wait for spring.',
];
const PMAIN = `\\documentclass{article}\n\\begin{document}\n${PARAS.join('\n\n')}\n\\end{document}\n`;
async function lines(entries: Record<string, string>) {
  const zip = await writeZip(
    Object.entries(entries).map(([path, s]) => ({ path, bytes: Buffer.from(s) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Restore');
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  return { id: project.id as string, ids, main: ids['main.tex'] as string };
}
async function docOf(file: string) {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  return { doc, text: doc.getText(TEXT) };
}
const textOf = async (file: string) => (await docOf(file)).text.toString();
async function ends(file: string, words: string) {
  const { text } = await docOf(file);
  const at = text.toString().indexOf(words);
  return {
    from: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, 0)),
    to: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, at + words.length, -1),
    ),
  };
}
const editP1P5 = async (file: string) => {
  await replace(file, 'foxes jump', 'foxes sprint');
  await replace(file, 'bears wait', 'bears hibernate');
};
const states = async (projectId: string) => ({
  threads: (await listThreads(t.pool, store, owner.id, projectId)).map((x) => x.state),
  proposals: await listProposals(t.pool, store, owner.id, projectId),
});
async function paperWithAnchors() {
  const p = await lines({ 'main.tex': PMAIN });
  await startThread(t.pool, store, owner.id, p.id, p.main, {
    ...(await ends(p.main, 'gamma wolves')),
    body: 'Which wolves?',
  });
  const prop = await propose(t.pool, store, owner.id, p.id, p.main, {
    ...(await ends(p.main, 'howl loudly')),
    replacement: 'howl softly',
  });
  return { ...p, prop };
}

test('words nobody touched keep their thread and proposal through a restore', async () => {
  const p = await paperWithAnchors();
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
  await editP1P5(p.main);
  await restoreRevision(t.pool, store, owner.id, p.id, a.id);
  expect(await textOf(p.main)).toBe(PMAIN);
  const after = await states(p.id);
  expect(after.threads).toEqual(['attached']);
  expect(after.proposals).toMatchObject([{ stale: false, now: 'howl loudly' }]);
  await acceptProposal(t.pool, store, owner.id, p.id, p.prop);
  expect(await textOf(p.main)).toBe(PMAIN.replace('howl loudly', 'howl softly'));
});

test('a proposal accepted before the revision can still be undone after a restore', async () => {
  const p = await paperWithAnchors();
  await acceptProposal(t.pool, store, owner.id, p.id, p.prop);
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
  await editP1P5(p.main);
  await restoreRevision(t.pool, store, owner.id, p.id, a.id);
  expect((await states(p.id)).proposals).toMatchObject([{ status: 'accepted', stale: false }]);
  await undoAccept(t.pool, store, owner.id, p.id, p.prop);
  expect(await textOf(p.main)).toBe(PMAIN);
});

test('a change on the same line leaves the words beside it anchored', async () => {
  const p = await paperWithAnchors();
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
  await replace(p.main, 'night', 'dusk');
  await restoreRevision(t.pool, store, owner.id, p.id, a.id);
  expect(await textOf(p.main)).toBe(PMAIN);
  const after = await states(p.id);
  expect(after.threads).toEqual(['attached']);
  expect(after.proposals).toMatchObject([{ stale: false, now: 'howl loudly' }]);
  await acceptProposal(t.pool, store, owner.id, p.id, p.prop);
});

test('lines that share no word are replaced whole, and the lines around them are not touched', async () => {
  // Pure: the stretch kept at either end is only ever whole words.
  expect(restoreEdits('aaa bbb\nkeep\n', 'ccc ddd\nkeep\n')).toEqual([
    { at: 0, del: 7, ins: 'ccc ddd' },
  ]);
  expect(restoreEdits('say howl loudly now\n', 'say howl softly now\n')).toEqual([
    { at: 9, del: 6, ins: 'softly' },
  ]);
  expect(restoreEdits('abcdef\n', 'abcxyf\n')).toEqual([{ at: 0, del: 6, ins: 'abcxyf' }]);

  const before = 'one\naaa bbb\nthree words here\nccc\nfive\n';
  const now = 'one\nxxx yyy\nthree words here\nzzz\nfive\n';
  const p = await lines({ 'main.tex': PMAIN, 'x.tex': before });
  const x = p.ids['x.tex'];
  await startThread(t.pool, store, owner.id, p.id, x, {
    ...(await ends(x, 'words here')),
    body: 'Between two changes.',
  });
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
  await replace(x, 'aaa bbb', 'xxx yyy');
  await replace(x, 'ccc', 'zzz');
  expect(await textOf(x)).toBe(now);
  await restoreRevision(t.pool, store, owner.id, p.id, a.id);
  expect(await textOf(x)).toBe(before);
  expect((await states(p.id)).threads).toEqual(['attached']);
});

test('a file restores to the byte, with a final newline or without one', async () => {
  const pairs: [string, string][] = [
    ['one\ntwo\nthree', 'one\ntwo\nthree EDITED'],
    ['one\ntwo\nthree tail', 'one\ntwo\nthree'],
    ['a\nb\n', 'a\nb'],
    ['a\nb', 'a\nb\n'],
    ['a\nb\nc', 'a'],
    ['a', 'a\nb\nc'],
    ['a\nb\nc\n', 'a\n'],
    ['a\n', 'a\nb\nc\n'],
    ['keep\nold one\nold two', 'keep\nnew'],
    ['keep\nold', 'keep\nnew one\nnew two\n'],
    ['x\nx\nx\nx\n', 'x\nx\n'],
    ['', 'text'],
    ['text', ''],
    // Changes at both ends with a line between them that must stay anchored.
    ['first\nkeep this line\nlast', 'FIRST\nkeep this line\nLAST'],
    ['first\nkeep this line\nlast\n', 'FIRST\nkeep this line\nLAST\n'],
  ];
  for (const [want, now] of pairs) {
    const p = await lines({ 'main.tex': PMAIN, 'x.tex': want });
    const x = p.ids['x.tex'];
    const kept = want.includes('keep this line');
    if (kept)
      await startThread(t.pool, store, owner.id, p.id, x, {
        ...(await ends(x, 'keep this line')),
        body: 'Between two changes.',
      });
    const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
    if (kept) {
      await replace(x, 'first', 'FIRST');
      await replace(x, 'last', 'LAST');
    } else
      await edit(x, (text) => {
        text.delete(0, text.length);
        text.insert(0, now);
      });
    await restoreRevision(t.pool, store, owner.id, p.id, a.id);
    if (kept) expect((await states(p.id)).threads).toEqual(['attached']);
    const out = (await readZip(await exportZip(t.pool, store, owner.id, p.id))).entries.find(
      (e) => e.path === 'x.tex',
    )!;
    expect(Buffer.from(out.bytes).toString(), JSON.stringify([want, now])).toBe(want);
    expect(await textOf(x)).toBe(want);
  }
});

test('a file too large to compare line by line is still restored exactly', async () => {
  const make = (prefix: string) =>
    Array.from({ length: 2100 }, (_, i) => `${prefix} line ${i}`).join('\n') + '\n';
  const [want, now] = [make('old'), make('new')];
  // Past what the line diff will compare, so the restore falls back to one stretch.
  expect(diffLines(want, now)).toBeNull();
  const p = await lines({ 'main.tex': PMAIN, 'big.tex': want });
  const big = p.ids['big.tex'];
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
  await edit(big, (text) => {
    text.delete(0, text.length);
    text.insert(0, now);
  });
  await restoreRevision(t.pool, store, owner.id, p.id, a.id);
  expect(await textOf(big)).toBe(want);
  const out = (await readZip(await exportZip(t.pool, store, owner.id, p.id))).entries.find(
    (e) => e.path === 'big.tex',
  )!;
  expect(Buffer.from(out.bytes).toString()).toBe(want);
});

test("a second person's typing in an untouched paragraph survives a restore whole", async () => {
  const p = await paperWithAnchors();
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
  await editP1P5(p.main);
  // Their editor has the paper as it is now, and the restore has not reached it yet.
  const { doc: theirs, text: theirText } = await docOf(p.main);
  await restoreRevision(t.pool, store, owner.id, p.id, a.id);
  const at = theirText.toString().indexOf('howl ') + 5;
  const sent: Uint8Array[] = [];
  theirs.on('update', (u: Uint8Array) => sent.push(u));
  for (const [i, letter] of [...'abcdefgh'].entries()) theirText.insert(at + i, letter);
  for (const u of sent) await appendUpdate(t.pool, p.main, owner.id, u);
  expect(await textOf(p.main)).toBe(PMAIN.replace('howl loudly', 'howl abcdefghloudly'));
});

// A restore holds every file of the paper only while it writes. The store here is as far away as
// the database may be from a web app on Vercel, and the tests below watch what is done while the
// files are held.
const FILES = 30;
const original = (i: number) => `one ${i} alpha\ntwo beta\nthree gamma\n`;
const changed = (i: number) => `ONE ${i} ALPHA\ntwo changed\nthree GAMMA\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const far = (ms: number) => ({
  ...store,
  put: async (bytes: Uint8Array) => (await sleep(ms), store.put(bytes)),
  get: async (digest: string) => (await sleep(ms), store.get(digest)),
  size: async (digest: string) => (await sleep(ms), store.size(digest)),
});
type Seen = { sql: string; params: unknown[] | undefined; tx: boolean };
/** The pool, noting every statement; `after` may act once a statement outside a transaction is done. */
function watched(
  seen: Seen[],
  after?: (sql: string, params?: unknown[]) => Promise<void>,
  inTx?: (sql: string) => void,
) {
  const mine = (target: object, prop: string | symbol) => {
    const v = Reflect.get(target, prop);
    return typeof v === 'function' ? v.bind(target) : v;
  };
  return new Proxy(t.pool, {
    get(target, prop) {
      if (prop === 'query')
        return async (sql: string, params?: unknown[]) => {
          seen.push({ sql, params, tx: false });
          const result = await target.query(sql, params);
          await after?.(sql, params);
          return result;
        };
      if (prop === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get: (c, p) =>
              p === 'query'
                ? (sql: string, params?: unknown[]) => (
                    seen.push({ sql, params, tx: true }),
                    inTx?.(sql),
                    c.query(sql, params)
                  )
                : mine(c, p),
          });
        };
      return mine(target, prop);
    },
  });
}
/** A paper of many files, saved, then every file changed. */
async function manyEdited() {
  const entries: Record<string, string> = { 'main.tex': PMAIN };
  for (let i = 0; i < FILES; i++) entries[`f${String(i).padStart(2, '0')}.tex`] = original(i);
  const p = await lines(entries);
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
  const names = Object.keys(entries).filter((n) => n !== 'main.tex');
  for (const [i, n] of names.entries())
    await edit(p.ids[n], (text) => (text.delete(0, text.length), text.insert(0, changed(i))));
  return { ...p, a, names };
}

test('typing during a restore waits only while the restore writes', async () => {
  const p = await manyEdited();
  const seen: Seen[] = [];
  let held!: () => void;
  const locked = new Promise<void>((r) => (held = r));
  // Note when the files are held: the statement that locks them.
  const spy = watched(seen, undefined, (sql) => /for update/.test(sql) && held());
  const restoring = restoreRevision(spy, far(50), owner.id, p.id, p.a.id);
  await locked;
  await sleep(100);
  const typed = p.ids[p.names[7]];
  const started = Date.now();
  await edit(typed, (text) => text.insert(0, 'Q'));
  const waited = Date.now() - started;
  await restoring;
  expect(waited).toBeLessThan(1500);
  for (const [i, n] of p.names.entries())
    expect(await textOf(p.ids[n])).toBe((n === p.names[7] ? 'Q' : '') + original(i));
});

test('a restore makes a bounded number of statements while the files are held', async () => {
  const p = await manyEdited();
  const seen: Seen[] = [];
  await restoreRevision(watched(seen), store, owner.id, p.id, p.a.id);
  const tx = seen.filter((s) => s.tx);
  const from = tx.findIndex((s) => /for update/.test(s.sql));
  const held = tx.slice(from);
  expect(held.at(-1)!.sql).toBe('commit');
  expect(held.length).toBeLessThan(40);
  for (const [i, n] of p.names.entries()) expect(await textOf(p.ids[n])).toBe(original(i));
});

test('typing in the moment before a restore holds is not lost, and that file alone is read again', async () => {
  const p = await manyEdited();
  const seen: Seen[] = [];
  const typed = p.ids[p.names[3]];
  let once = false;
  let batches = 0;
  // Just after the restore has read every log, and before it holds the files. The first read of
  // them all is for storing what is edited; the second is the restore's own.
  const pool = watched(seen, async (sql) => {
    if (once || !/from file_updates where file_id = any/.test(sql) || ++batches < 2) return;
    once = true;
    await edit(typed, (text) => text.insert(0, 'Q'));
  });
  const restored = await restoreRevision(pool, store, owner.id, p.id, p.a.id);
  for (const [i, n] of p.names.entries()) expect(await textOf(p.ids[n])).toBe(original(i));
  // Only that file's log is read while the files are held: to keep the paper as it stood, to
  // restore it, and to cut the restore. The other files used what was made ahead of time.
  const reads = seen.filter((s) => s.tx && /from file_updates/.test(s.sql));
  expect(new Set(reads.map((s) => (s.params as string[])[0]))).toEqual(new Set([typed]));
  expect(reads).toHaveLength(3);
  expect(once).toBe(true);
  // What was typed is in the revision kept just before the restore.
  const kept = (await listRevisions(t.pool, owner.id, p.id)).find(
    (r) => r.number === restored.number - 1,
  )!;
  const { rows } = await t.pool.query(
    'select digest from revision_files where revision_id = $1 and file_id = $2',
    [kept.id, typed],
  );
  expect(Buffer.from((await store.get(rows[0].digest))!).toString()).toBe('Q' + changed(3));
});

test('restoring a file with mixed line endings records the restore, and the next automatic cut finds nothing new', async () => {
  const mixed = 'one\r\ntwo\nthree\nfour\n';
  const p = await lines({ 'main.tex': PMAIN, 'x.tex': mixed });
  const x = p.ids['x.tex'];
  const a = await saveRevision(t.pool, store, owner.id, p.id, 'A');
  await replace(x, 'three', 'THREE');
  await restoreRevision(t.pool, store, owner.id, p.id, a.id);
  const restored = await lastRestore(t.pool, owner.id, x);
  const cut = await cutRevision(t.pool, store, owner.id, p.id);
  expect(cut.number).toBe(restored);
  const out = (await readZip(await exportZip(t.pool, store, owner.id, p.id))).entries.find(
    (e) => e.path === 'x.tex',
  )!;
  expect(Buffer.from(out.bytes).toString()).toBe('one\ntwo\nthree\nfour\n');
});

// A paper with a Latin-1 refs.bib (read-only), a first revision, and a UTF-8 replacement of it.
const LATIN = Buffer.from('@book{a, author = {Jos\xe9}}\n', 'latin1');
const UTF8 = Buffer.from('@book{a, author = {Jos\u00e9}}\n');
async function latinPaper() {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(PMAIN) },
    { path: 'refs.bib', bytes: LATIN },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Latin');
  const bib = (await listFiles(t.pool, owner.id, project.id)).find(
    (f) => f.path === 'refs.bib',
  )!.id;
  const r1 = await saveRevision(t.pool, store, owner.id, project.id, 'Latin-1');
  await replaceFile(t.pool, store, owner.id, project.id, 'refs.bib', UTF8);
  return { id: project.id as string, bib, r1 };
}
const row = async (file: string) =>
  (await t.pool.query('select eol, bom, readonly_reason as ro from files where id = $1', [file]))
    .rows[0];
const exported = async (projectId: string) =>
  Buffer.from(
    (await readZip(await exportZip(t.pool, store, owner.id, projectId))).entries.find(
      (e) => e.path === 'refs.bib',
    )!.bytes,
  );
const readonlyOf = async (projectId: string) =>
  (await listFiles(t.pool, owner.id, projectId)).find((f) => f.path === 'refs.bib')!.readonly;

test('restoring a revision from before a file was made UTF-8 puts back its bytes and makes it read-only again', async () => {
  // Never opened.
  let p = await latinPaper();
  expect((await row(p.bib)).eol).toBe('lf');
  await restoreRevision(t.pool, store, owner.id, p.id, p.r1.id);
  expect((await row(p.bib)).eol).toBeNull();
  expect(await readonlyOf(p.id)).toBe('not-utf8');
  expect((await exported(p.id)).equals(LATIN)).toBe(true);

  // Opened, not edited.
  p = await latinPaper();
  await loadUpdates(t.pool, store, p.bib);
  await restoreRevision(t.pool, store, owner.id, p.id, p.r1.id);
  expect(await code(edit(p.bib, (x) => x.insert(0, 'w')))).toBe('not_found');
  expect((await exported(p.id)).equals(LATIN)).toBe(true);

  // Edited.
  p = await latinPaper();
  await edit(p.bib, (x) => x.insert(0, '% word\n'));
  const made = await restoreRevision(t.pool, store, owner.id, p.id, p.r1.id);
  expect((await exported(p.id)).equals(LATIN)).toBe(true);
  const bytes = (await exportRevision(t.pool, store, owner.id, p.id, made.id)).zip;
  const inRev = (await readZip(bytes)).entries.find((e) => e.path === 'refs.bib')!;
  expect(Buffer.from(inRev.bytes).equals(LATIN)).toBe(true);
});

test('restoring forward again makes the file editable text with its history', async () => {
  const p = await latinPaper();
  await edit(p.bib, (x) => x.insert(0, '% word\n'));
  const edited = Buffer.from('% word\n' + UTF8.toString());
  const at = (await textOf(p.bib)).indexOf('word');
  await startThread(t.pool, store, owner.id, p.id, p.bib, {
    from: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex((await docOf(p.bib)).text, at, 0),
    ),
    to: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex((await docOf(p.bib)).text, at + 4, -1),
    ),
    body: 'Which word?',
  });
  const back = await restoreRevision(t.pool, store, owner.id, p.id, p.r1.id);
  expect((await row(p.bib)).eol).toBeNull();
  const kept = (await listRevisions(t.pool, owner.id, p.id)).find(
    (r) => r.number === back.number - 1,
  )!;
  await restoreRevision(t.pool, store, owner.id, p.id, kept.id);
  expect(await row(p.bib)).toMatchObject({ eol: 'lf', ro: null });
  expect(await textOf(p.bib)).toBe(edited.toString());
  expect((await exported(p.id)).equals(edited)).toBe(true);
  const threads = await listThreads(t.pool, store, owner.id, p.id);
  expect(threads).toHaveLength(1);
  expect(threads[0].now).not.toBe('');
  await replace(p.bib, 'Jos', 'JOS');
  expect((await exported(p.id)).toString()).toContain('JOS');
});

test('a read-only file that was once text takes a UTF-8 replacement into its log', async () => {
  const p = await latinPaper();
  await edit(p.bib, (x) => x.insert(0, '% word\n'));
  await restoreRevision(t.pool, store, owner.id, p.id, p.r1.id);
  const v = Buffer.from('@book{b, author = {V\u00e9}}\n');
  await replaceFile(t.pool, store, owner.id, p.id, 'refs.bib', v);
  expect(await textOf(p.bib)).toBe(v.toString());
  expect((await exported(p.id)).equals(v)).toBe(true);
});

/**
 * A paper with a cover letter, an old draft and held data, whose revision "was built" with what
 * TeX opened as given (no build when `read` is undefined). No TeX here: the worker's own tests
 * run it.
 */
async function usedPaper(read?: string[] | null) {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: 'body.tex', bytes: Buffer.from(BODY) },
    { path: 'refs.bib', bytes: Buffer.from('@book{k, title={T}, year=2001}\n') },
    { path: 'cover-letter.tex', bytes: Buffer.from('Dear editor.\n') },
    { path: 'old/draft.pdf', bytes: Buffer.from('%PDF-1.4\n') },
    { path: 'fig.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
    { path: 'data.csv', bytes: Buffer.from('day,ms\n1,9\n2,38\n') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Used');
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  // The CSV is data kept out of downloads.
  await approveDataset(t.pool, store, owner.id, project.id, ids['data.csv'], {
    version: (await datasetProposal(t.pool, store, owner.id, project.id, ids['data.csv'])).version,
    columns: [
      { name: 'day', type: 'number', unit: '' },
      { name: 'ms', type: 'number', unit: 'ms' },
    ],
    missing: [],
    exported: false,
  });
  const revision = await saveRevision(t.pool, store, owner.id, project.id, 'Cut');
  const built = (at: string, status: string, what: unknown) =>
    t.pool.query(
      `insert into builds (project_id, status, pdf_digest, revision_id, finished_at, created_at, read)
       values ($1, $2, repeat('a', 64), $3, now(), $4, $5)`,
      [project.id, status, revision.id, at, what === undefined ? null : JSON.stringify(what)],
    );
  if (read !== undefined) await built('2030-01-01', 'succeeded', read);
  return { id: project.id, revision, built };
}
const listing = (zip: Uint8Array) => {
  const file = join(mkdtempSync(join(tmpdir(), 'paperweave-test-')), 'revision.zip');
  writeFileSync(file, zip);
  return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
};
const READ = ['main.tex', 'body.tex', 'refs.bib', 'fig.png', 'data.csv'];

test('the ZIP of only the files the paper uses leaves out what the build never opened, and says so', async () => {
  const p = await usedPaper(READ);
  const used = await exportRevision(t.pool, store, owner.id, p.id, p.revision.id, true, [], true);
  // Held data stays out of every ZIP, and is not named as unused; nothing else is gone but the two.
  expect(listing(used.zip)).toEqual([
    'body.tex',
    'fig.png',
    'main.tex',
    'paperweave-toolchain.json',
    'refs.bib',
  ]);
  const manifest = manifestOf(used.zip);
  expect(Object.keys(manifest.files).sort()).toEqual([
    'body.tex',
    'fig.png',
    'main.tex',
    'refs.bib',
  ]);
  expect(manifest.unused).toEqual(['cover-letter.tex', 'old/draft.pdf']);
  expect(manifest.held).toEqual(['data.csv']);
  expect(await unusedInRevision(t.pool, owner.id, p.id, p.revision.id)).toEqual([
    'cover-letter.tex',
    'old/draft.pdf',
  ]);
  // The streamed archive is the same.
  const streamed = await exportRevisionStream(
    t.pool,
    store,
    owner.id,
    p.id,
    p.revision.id,
    false,
    [],
    true,
  );
  const chunks: Uint8Array[] = [];
  for await (const c of streamed.zip) chunks.push(c);
  expect(listing(Buffer.concat(chunks))).toEqual(['body.tex', 'fig.png', 'main.tex', 'refs.bib']);
});

test('the plain ZIP and the manifest ZIP are as they were, whether or not the revision was built', async () => {
  const p = await usedPaper();
  const before = await exportRevision(t.pool, store, owner.id, p.id, p.revision.id);
  const beforeManifest = manifestOf(
    (await exportRevision(t.pool, store, owner.id, p.id, p.revision.id, true)).zip,
  );
  expect(listing(before.zip)).toEqual([
    'body.tex',
    'cover-letter.tex',
    'fig.png',
    'main.tex',
    'old/draft.pdf',
    'refs.bib',
  ]);
  await p.built('2030-01-01', 'succeeded', READ);
  const after = await exportRevision(t.pool, store, owner.id, p.id, p.revision.id);
  expect(Buffer.from(after.zip).equals(Buffer.from(before.zip))).toBe(true);
  const afterManifest = manifestOf(
    (await exportRevision(t.pool, store, owner.id, p.id, p.revision.id, true)).zip,
  );
  // Nothing about unused files in it, and nothing else different.
  expect('unused' in afterManifest).toBe(false);
  expect(afterManifest).toEqual(beforeManifest);
});

test('a revision that has not been built has no ZIP of only the files used', async () => {
  const p = await usedPaper();
  expect(
    await code(exportRevision(t.pool, store, owner.id, p.id, p.revision.id, false, [], true)),
  ).toBe('not_found');
  expect(
    await code(exportRevision(t.pool, store, owner.id, p.id, p.revision.id, true, [], true)),
  ).toBe('not_found');
  expect(
    await code(exportRevisionStream(t.pool, store, owner.id, p.id, p.revision.id, false, [], true)),
  ).toBe('not_found');
  expect(await unusedInRevision(t.pool, owner.id, p.id, p.revision.id)).toEqual([]);
  // A build that failed made nothing to go by.
  await p.built('2030-01-01', 'failed', undefined);
  expect(
    await code(exportRevision(t.pool, store, owner.id, p.id, p.revision.id, false, [], true)),
  ).toBe('not_found');
});

test('a build that did not say what it read leaves nothing out, and the newest good build decides', async () => {
  const p = await usedPaper(null);
  const all = await exportRevision(t.pool, store, owner.id, p.id, p.revision.id, false, [], true);
  expect(listing(all.zip)).toHaveLength(6);
  expect(await unusedInRevision(t.pool, owner.id, p.id, p.revision.id)).toEqual([]);
  // An older build that read less, and a newer failed one, do not decide.
  await p.built('2029-01-01', 'succeeded', ['main.tex']);
  await p.built('2031-01-01', 'failed', ['main.tex']);
  expect(await unusedInRevision(t.pool, owner.id, p.id, p.revision.id)).toEqual([]);
  await p.built('2032-01-01', 'succeeded', [...READ, 'cover-letter.tex']);
  expect(await unusedInRevision(t.pool, owner.id, p.id, p.revision.id)).toEqual(['old/draft.pdf']);
});

test('only a type TeX reads as a figure or a source can be left out, and the root never', async () => {
  // Only the root is read: a .bib, a .png and the others of the types the ZIP may drop.
  const p = await usedPaper(['main.tex']);
  expect(await unusedInRevision(t.pool, owner.id, p.id, p.revision.id)).toEqual([
    'body.tex',
    'cover-letter.tex',
    'fig.png',
    'old/draft.pdf',
  ]);
  const none = await usedPaper([]);
  expect(await unusedInRevision(t.pool, owner.id, none.id, none.revision.id)).not.toContain(
    'main.tex',
  );
  expect(await unusedInRevision(t.pool, owner.id, none.id, none.revision.id)).not.toContain(
    'refs.bib',
  );
});

test('who may have the ZIP of only the files used: those who may have any ZIP', async () => {
  const p = await usedPaper(READ);
  const people: Record<string, { id: string }> = { owner };
  for (const role of ['editor', 'reviewer', 'viewer'] as const) {
    const who = await t.signIn(`${role}-used@example.org`);
    const { token } = await invite(t.pool, owner.id, p.id, `${role}-used@example.org`, role);
    await acceptInvitation(t.pool, who.id, token);
    people[role] = who;
  }
  const ask = (id: string, project = p.id, revision = p.revision.id) =>
    code(exportRevision(t.pool, store, id, project, revision, false, [], true));
  expect(await ask(people.owner.id)).toBe('ok');
  expect(await ask(people.editor.id)).toBe('ok');
  expect(await ask(people.reviewer.id)).toBe('permission_denied');
  expect(await ask(people.viewer.id)).toBe('permission_denied');
  expect(await ask(outsider.id)).toBe('not_found');
  // Whoever may read the paper may be told which files are unused; nobody else.
  expect(await unusedInRevision(t.pool, people.viewer.id, p.id, p.revision.id)).toHaveLength(2);
  expect(await code(unusedInRevision(t.pool, outsider.id, p.id, p.revision.id))).toBe('not_found');

  // A revision of another paper cannot be reached through this one.
  const other = await usedPaper(READ);
  expect(await ask(owner.id, p.id, other.revision.id)).toBe('not_found');
  expect(await code(unusedInRevision(t.pool, owner.id, p.id, other.revision.id))).toBe('not_found');
});
