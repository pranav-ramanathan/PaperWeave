// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { createFile, deleteFile, replaceFile, setRootFile } from './files.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { applyMerge, type MergeChoices } from './merge-apply.ts';
import { listMerges, type MergePlan, planMerge } from './merge.ts';
import { setCompiler } from './projects.ts';
import {
  cutRevision,
  lastRestoreNote,
  listRevisions,
  renameFile,
  restoreNote,
  restoreRevision,
  restoreThatRemoved,
} from './revisions.ts';
import { appendUpdate, editFile, loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { startVersion } from './versions.ts';

const store = blobStore(TEST_ENV);
const ON = { VERSIONS: '1' };
const MAIN = '\\documentclass{article}\n\\begin{document}\n\\input{body}\n\\end{document}\n';
const BODY = 'Alpha one.\n\nBeta two.\n\nGamma three.\n';
const INTRO = 'Intro text.\n';
const PNG = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, n, 2, 3]);
let t: Awaited<ReturnType<typeof testDb>>;
type User = { id: string; email: string };
const users = {} as Record<'owner' | 'editor' | 'reviewer' | 'viewer' | 'outsider', User>;
let seq = 0;

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'editor', 'reviewer', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
});
afterAll(() => t.close());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );
const message = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e) => e.message as string,
  );

/** A paper, a version of it begun at its first revision, and the file ids on both sides by path. */
async function setup(entries: Record<string, string | Buffer> = {}) {
  const files = {
    'main.tex': MAIN,
    'body.tex': BODY,
    'intro.tex': INTRO,
    'fig.png': PNG(1),
    ...entries,
  };
  const zip = await writeZip(
    Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) })),
  );
  const [project] = await importZip(t.pool, store, users.owner.id, zip, `Paper ${++seq}`);
  for (const role of ['editor', 'reviewer', 'viewer'] as const)
    await t.pool.query(
      'insert into project_members (project_id, user_id, role) values ($1, $2, $3)',
      [project.id, users[role].id, role],
    );
  const main = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, project.id)).map((f) => [f.path, f.id as string]),
  );
  const first = await cutRevision(t.pool, store, users.owner.id, project.id);
  const v = await startVersion(
    t.pool,
    store,
    users.owner.id,
    project.id,
    first.id,
    'camera-ready',
    { env: ON },
  );
  const ver = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, v.id)).map((f) => [f.path, f.id as string]),
  );
  return { main, ver, mainId: project.id as string, verId: v.id as string, first: first.id };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const write = (fileId: string, text: string, who = users.owner) =>
  editFile(t.pool, store, fileId, who.id, (y) => {
    y.delete(0, y.length);
    y.insert(0, text);
  });
async function docOf(file: string) {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  return { doc, text: doc.getText(TEXT) };
}
const textOf = async (file: string) => (await docOf(file)).text.toString();

const plan = (target: string, source: string, who = users.owner) =>
  planMerge(t.pool, store, who.id, target, source);
const ref = (p: MergePlan) => ({
  target: p.target.revision,
  source: p.source.revision,
  base: p.base.revision,
});
const merge = (s: Setup, p: MergePlan, choices: MergeChoices = {}, who = users.owner) =>
  applyMerge(t.pool, store, who.id, s.mainId, s.verId, ref(p), choices);

/** Everything a paper holds that a merge may change, by name: bytes, compiler and root. */
async function snapshot(paper: string) {
  const zip = await readZip(await exportZip(t.pool, store, users.owner.id, paper));
  const row = (
    await t.pool.query(
      `select p.compiler, (select path from files where id = p.root_file_id) as root
       from projects p where id = $1`,
      [paper],
    )
  ).rows[0];
  return {
    files: Object.fromEntries(
      zip.entries.map((e) => [e.path, Buffer.from(e.bytes).toString('base64')]),
    ),
    ...row,
  };
}
const paths = async (paper: string) =>
  (await listFiles(t.pool, users.owner.id, paper)).map((f) => f.path).sort();
const revisionsOf = async (paper: string) =>
  (await t.pool.query('select count(*)::int as n from revisions where project_id = $1', [paper]))
    .rows[0].n as number;
const merges = async (paper: string) =>
  (await t.pool.query('select * from merges where target_id = $1 order by at', [paper])).rows;

test('a clean merge of a version into its paper, and undoing it', async () => {
  const s = await setup();
  await write(s.main['intro.tex'], 'Intro by main.\n');
  await write(s.main['body.tex'], 'Alpha by main.\n\nBeta two.\n\nGamma three.\n');
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  await write(s.ver['main.tex'], MAIN + '% version\n');
  const before = await snapshot(s.mainId);
  const p = await plan(s.mainId, s.verId);
  const made = await merge(s, p);

  expect(await textOf(s.main['body.tex'])).toBe(
    'Alpha by main.\n\nBeta two.\n\nGamma by version.\n',
  );
  expect(await textOf(s.main['intro.tex'])).toBe('Intro by main.\n');
  expect(await textOf(s.main['main.tex'])).toBe(MAIN + '% version\n');

  // A revision of kind merge, made of the version's revision; the paper as it stood just before
  // is kept; a row of `merges` says so; the version's base moved to what was merged.
  const rev = (
    await t.pool.query('select kind, merged_from, number from revisions where id = $1', [made.id])
  ).rows[0];
  expect(rev).toMatchObject({ kind: 'merge', merged_from: p.source.revision, number: made.number });
  expect(made.kept.number).toBe(made.number - 1);
  const [row] = await merges(s.mainId);
  expect(row).toMatchObject({
    target_id: s.mainId,
    source_id: s.verId,
    source_revision: p.source.revision,
    kept_revision: made.kept.id,
    result_revision: made.id,
    base_revision: p.base.revision,
    conflicts: 0,
    by: users.owner.id,
    files: 2,
  });
  expect(
    (await t.pool.query('select base_revision_id from projects where id = $1', [s.verId])).rows[0]
      .base_revision_id,
  ).toBe(p.source.revision);
  expect((await listRevisions(t.pool, users.owner.id, s.mainId)).map((r) => r.kind)).toContain(
    'merge',
  );

  // Undo is restoring the kept revision: the paper is back, byte for byte.
  await restoreRevision(t.pool, store, users.owner.id, s.mainId, made.kept.id);
  expect(await snapshot(s.mainId)).toEqual(before);
});

test('bringing a version up to date is the same merge the other way round', async () => {
  const s = await setup();
  await write(s.main['body.tex'], 'Alpha by main.\n\nBeta two.\n\nGamma three.\n');
  await write(s.ver['intro.tex'], 'Intro by version.\n');
  const p = await plan(s.verId, s.mainId);
  const made = await applyMerge(t.pool, store, users.owner.id, s.verId, s.mainId, ref(p), {});
  expect(await textOf(s.ver['body.tex'])).toBe('Alpha by main.\n\nBeta two.\n\nGamma three.\n');
  expect(await textOf(s.ver['intro.tex'])).toBe('Intro by version.\n');
  expect((await merges(s.verId))[0]).toMatchObject({ target_id: s.verId, source_id: s.mainId });
  expect(made.kept.number).toBe(made.number - 1);
  // Nothing is left to bring across.
  const again = await plan(s.verId, s.mainId);
  expect(again.counts).toMatchObject({ taken: 0, merged: 0, added: 0, removed: 0, conflicts: 0 });
});

const PARAS = (tag: string) =>
  [1, 2, 3, 4, 5].map((i) => `Para ${i} colour ${tag}.`).join('\n\nSeparator.\n\n') + '\n';

test('each kind of choice settles a conflict', async () => {
  const s = await setup({ 'body.tex': PARAS('base') });
  await write(s.main['body.tex'], PARAS('main'));
  await write(s.ver['body.tex'], PARAS('ver'));
  const p = await plan(s.mainId, s.verId);
  expect(p.conflicts).toHaveLength(5);
  const [c1, c2, c3, c4, c5] = p.conflicts.map((c) => c.id);
  const made = await merge(s, p, {
    [c1]: 'ours',
    [c2]: 'theirs',
    [c3]: 'both',
    [c4]: 'base',
    [c5]: { text: 'mi\r\nne' },
  });
  const text = await textOf(s.main['body.tex']);
  expect(text.split('\n\nSeparator.\n\n')).toEqual([
    'Para 1 colour main.',
    'Para 2 colour ver.',
    expect.stringMatching(/^Para 3 colour main.*ver\./),
    'Para 4 colour base.',
    // A text box sends CRLF; the file holds LF.
    'Para 5 colour mi\nne.\n',
  ]);
  expect(made.conflicts).toBe(5);
  expect((await merges(s.mainId))[0].conflicts).toBe(5);
});

test('a picture changed on both sides is one side or the other', async () => {
  for (const [choice, kept] of [
    ['ours', PNG(7)],
    ['theirs', PNG(8)],
  ] as const) {
    const s = await setup();
    await replaceFile(t.pool, store, users.owner.id, s.mainId, 'fig.png', PNG(7));
    await replaceFile(t.pool, store, users.owner.id, s.verId, 'fig.png', PNG(8));
    const p = await plan(s.mainId, s.verId);
    expect(p.conflicts).toHaveLength(1);
    await merge(s, p, { [p.conflicts[0].id]: choice });
    const now = await snapshot(s.mainId);
    expect(now.files['fig.png']).toBe(kept.toString('base64'));
  }
  // Changed on the version only: taken.
  const q = await setup();
  await replaceFile(t.pool, store, users.owner.id, q.verId, 'fig.png', PNG(9));
  await merge(q, await plan(q.mainId, q.verId));
  expect((await snapshot(q.mainId)).files['fig.png']).toBe(PNG(9).toString('base64'));
});

test('files added, deleted and renamed are added, deleted and renamed, and undone together', async () => {
  const s = await setup();
  await createFile(t.pool, store, users.owner.id, s.verId, 'extra.tex', Buffer.from('extra\n'));
  await createFile(t.pool, store, users.owner.id, s.mainId, 'mine.tex', Buffer.from('mine\n'));
  await deleteFile(t.pool, store, users.owner.id, s.verId, s.ver['intro.tex']);
  await renameFile(t.pool, users.owner.id, s.verId, s.ver['body.tex'], 'chapter.tex');
  await write(s.main['body.tex'], 'Alpha by main.\n\nBeta two.\n\nGamma three.\n');
  const before = await snapshot(s.mainId);
  const p = await plan(s.mainId, s.verId);
  const made = await merge(s, p);
  expect(await paths(s.mainId)).toEqual([
    'chapter.tex',
    'extra.tex',
    'fig.png',
    'main.tex',
    'mine.tex',
  ]);
  // The renamed file is the same file, with the edit made on the paper.
  expect(await textOf(s.main['body.tex'])).toBe('Alpha by main.\n\nBeta two.\n\nGamma three.\n');
  expect(
    (await listFiles(t.pool, users.owner.id, s.mainId)).find((f) => f.path === 'chapter.tex')!.id,
  ).toBe(s.main['body.tex']);
  const extra = (await listFiles(t.pool, users.owner.id, s.mainId)).find(
    (f) => f.path === 'extra.tex',
  )!;
  expect(await textOf(extra.id as string)).toBe('extra\n');
  // The added file is the same file as the version's: it has its origin.
  const theirExtra = (await listFiles(t.pool, users.owner.id, s.verId)).find(
    (f) => f.path === 'extra.tex',
  )!;
  expect(
    (await t.pool.query('select origin_id from files where id = $1', [extra.id])).rows[0].origin_id,
  ).toBe(theirExtra.id);
  // The file that went is told of as removed by the merge.
  const removed = await restoreThatRemoved(t.pool, s.mainId, s.main['intro.tex']);
  expect(removed).toMatchObject({ number: made.number, merge: { version: 'camera-ready' } });

  await restoreRevision(t.pool, store, users.owner.id, s.mainId, made.kept.id);
  expect(await snapshot(s.mainId)).toEqual(before);
});

test('a file given a name another file had is a swap, and a deleted file frees its name', async () => {
  const s = await setup({ 'a.tex': 'A\n', 'b.tex': 'B\n' });
  await renameFile(t.pool, users.owner.id, s.verId, s.ver['a.tex'], 'tmp.tex');
  await renameFile(t.pool, users.owner.id, s.verId, s.ver['b.tex'], 'a.tex');
  await renameFile(t.pool, users.owner.id, s.verId, s.ver['a.tex'], 'a.tex').catch(() => {});
  const p = await plan(s.mainId, s.verId);
  await merge(s, p);
  expect(await paths(s.mainId)).toEqual(await paths(s.verId));
  expect(await textOf(s.main['b.tex'])).toBe('B\n');
});

test('the root and compiler of the version are taken, or decided if both changed them', async () => {
  const s = await setup();
  await setRootFile(t.pool, users.owner.id, s.verId, s.ver['intro.tex']);
  await setCompiler(t.pool, users.owner.id, s.verId, 'xelatex');
  await merge(s, await plan(s.mainId, s.verId));
  expect(await snapshot(s.mainId)).toMatchObject({ compiler: 'xelatex', root: 'intro.tex' });

  for (const choice of ['ours', 'theirs'] as const) {
    const u = await setup();
    await setCompiler(t.pool, users.owner.id, u.mainId, 'lualatex');
    await setCompiler(t.pool, users.owner.id, u.verId, 'xelatex');
    const p = await plan(u.mainId, u.verId);
    expect(p.settings.compiler.status).toBe('conflict');
    // The plan lists no conflict for it; the apply asks for one all the same.
    expect(await code(merge(u, p))).toBe('invalid_input');
    expect(await message(merge(u, p))).toContain('settings.compiler');
    expect(await code(merge(u, p, { 'settings.compiler': 'both' }))).toBe('invalid_input');
    await merge(u, p, { 'settings.compiler': choice });
    expect((await snapshot(u.mainId)).compiler).toBe(choice === 'ours' ? 'lualatex' : 'xelatex');
  }
});

test('a merge cannot leave the paper without its root file', async () => {
  const s = await setup();
  // The version deleted the file the paper builds from.
  await setRootFile(t.pool, users.owner.id, s.verId, s.ver['intro.tex']);
  await deleteFile(t.pool, store, users.owner.id, s.verId, s.ver['main.tex']);
  const p = await plan(s.mainId, s.verId);
  const before = await snapshot(s.mainId);
  expect(p.settings.root.status).toBe('taken');
  await merge(s, p);
  expect(await snapshot(s.mainId)).toMatchObject({ root: 'intro.tex' });
  expect(before.root).toBe('main.tex');
});

test('a file typed in since the plan was made refuses the merge, and changes nothing', async () => {
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const p = await plan(s.mainId, s.verId);
  await write(s.main['body.tex'], 'Alpha by main.\n\nBeta two.\n\nGamma three.\n');
  // (An export cuts the paper as it is, so it is made first.)
  const before = await snapshot(s.mainId);
  const revisions = await revisionsOf(s.mainId);
  expect(await code(merge(s, p))).toBe('conflict');
  expect(await message(merge(s, p))).toMatch(/changed while you were deciding/);
  expect(await revisionsOf(s.mainId)).toBe(revisions);
  expect(await merges(s.mainId)).toHaveLength(0);
  expect(await snapshot(s.mainId)).toEqual(before);
  // Looking again gives a plan that merges both people's work.
  await merge(s, await plan(s.mainId, s.verId));
  expect(await textOf(s.main['body.tex'])).toBe(
    'Alpha by main.\n\nBeta two.\n\nGamma by version.\n',
  );
});

test('typing in a file the merge does not change, or opening one, does not refuse it', async () => {
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const p = await plan(s.mainId, s.verId);
  await write(s.main['intro.tex'], 'Intro typed meanwhile.\n');
  // A file the merge changes, opened for the first time: its log begins, its text is as it was.
  await loadUpdates(t.pool, store, s.main['body.tex']);
  await merge(s, p);
  expect(await textOf(s.main['intro.tex'])).toBe('Intro typed meanwhile.\n');
  expect(await textOf(s.main['body.tex'])).toBe('Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  // The paper as it stood, with that typing, is the one kept.
  const [row] = await merges(s.mainId);
  const kept = (
    await t.pool.query(
      `select digest from revision_files where revision_id = $1 and path = 'intro.tex'`,
      [row.kept_revision],
    )
  ).rows[0].digest;
  expect(Buffer.from((await store.get(kept))!).toString()).toBe('Intro typed meanwhile.\n');
});

test('a file added, removed or renamed since the plan refuses the merge', async () => {
  const cases: [string, (s: Setup) => Promise<unknown>][] = [
    [
      'added',
      (s) => createFile(t.pool, store, users.owner.id, s.mainId, 'late.tex', Buffer.from('late\n')),
    ],
    ['removed', (s) => deleteFile(t.pool, store, users.owner.id, s.mainId, s.main['intro.tex'])],
    ['renamed', (s) => renameFile(t.pool, users.owner.id, s.mainId, s.main['intro.tex'], 'i.tex')],
  ];
  for (const [what, change] of cases) {
    const s = await setup();
    await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
    const p = await plan(s.mainId, s.verId);
    await change(s);
    const revisions = await revisionsOf(s.mainId);
    expect(await code(merge(s, p)), what).toBe('conflict');
    expect(await revisionsOf(s.mainId), what).toBe(revisions);
    expect(await textOf(s.main['body.tex']), what).toBe(BODY);
    expect(await merges(s.mainId), what).toHaveLength(0);
  }
  // The root or the compiler changed since.
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const p = await plan(s.mainId, s.verId);
  await setCompiler(t.pool, users.owner.id, s.mainId, 'lualatex');
  expect(await code(merge(s, p))).toBe('conflict');
});

test('only owners and editors may merge, in both papers', async () => {
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const p = await plan(s.mainId, s.verId);
  expect(await code(merge(s, p, {}, users.viewer))).toBe('permission_denied');
  expect(await code(merge(s, p, {}, users.reviewer))).toBe('permission_denied');
  expect(await code(merge(s, p, {}, users.outsider))).toBe('not_found');
  // Two papers that are not a version and its paper.
  const other = await setup();
  expect(
    await code(applyMerge(t.pool, store, users.owner.id, s.mainId, other.verId, ref(p), {})),
  ).toBe('invalid_input');
  expect(await merges(s.mainId)).toHaveLength(0);
  expect(await textOf(s.main['body.tex'])).toBe(BODY);
  // An editor may.
  await merge(s, p, {}, users.editor);
  expect((await merges(s.mainId))[0].by).toBe(users.editor.id);
  // Not someone who is on one of the papers only.
  const u = await setup();
  await write(u.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const q = await plan(u.mainId, u.verId);
  await t.pool.query('delete from project_members where project_id = $1 and user_id = $2', [
    u.verId,
    users.editor.id,
  ]);
  expect(await code(merge(u, q, {}, users.editor))).toBe('not_found');
  expect(await merges(u.mainId)).toHaveLength(0);
});

test('a merge without a choice for every conflict, or with one it does not allow, is refused', async () => {
  const s = await setup({ 'body.tex': PARAS('base') });
  await write(s.main['body.tex'], PARAS('main'));
  await write(s.ver['body.tex'], PARAS('ver'));
  await replaceFile(t.pool, store, users.owner.id, s.mainId, 'fig.png', PNG(7));
  await replaceFile(t.pool, store, users.owner.id, s.verId, 'fig.png', PNG(8));
  const p = await plan(s.mainId, s.verId);
  const ids = p.conflicts.map((c) => c.id);
  const picture = p.conflicts.find((c) => c.kind === 'binary')!.id;
  const all = Object.fromEntries(ids.map((i) => [i, 'ours' as const]));
  const revisions = await revisionsOf(s.mainId);

  expect(await code(merge(s, p))).toBe('invalid_input');
  const said = await message(merge(s, p, { [ids[0]]: 'ours' }));
  for (const i of ids.slice(1)) expect(said).toContain(i);
  expect(said).not.toContain(`${ids[0]},`);
  expect(await code(merge(s, p, { ...all, [picture]: 'both' }))).toBe('invalid_input');
  expect(await code(merge(s, p, { ...all, [picture]: { text: 'x' } }))).toBe('invalid_input');
  expect(await code(merge(s, p, { ...all, [ids[0]]: 'sideways' as never }))).toBe('invalid_input');
  expect(await code(merge(s, p, { ...all, [ids[0]]: { text: 5 as never } }))).toBe('invalid_input');
  expect(await code(merge(s, p, { ...all, 'not-a-conflict': 'ours' }))).toBe('invalid_input');
  // Revisions of other papers do not make a plan for these.
  const q = await plan(s.verId, s.mainId);
  expect(
    await code(applyMerge(t.pool, store, users.owner.id, s.mainId, s.verId, ref(q), all)),
  ).toBe('invalid_input');
  expect(await revisionsOf(s.mainId)).toBe(revisions);
  expect(await merges(s.mainId)).toHaveLength(0);

  await merge(s, p, all);
  expect(await merges(s.mainId)).toHaveLength(1);
});

test('a plan is applied once, and a merge costs the person their hour like a restore', async () => {
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const p = await plan(s.mainId, s.verId);
  expect(
    await code(
      applyMerge(
        t.pool,
        store,
        users.owner.id,
        s.mainId,
        s.verId,
        ref(p),
        {},
        { bytesPerHour: 1, floor: 100 },
      ),
    ),
  ).toBe('conflict');
  expect(await merges(s.mainId)).toHaveLength(0);
  await merge(s, p);
  // The version was merged: the same plan is out of date.
  expect(await code(merge(s, p))).toBe('conflict');
  expect(await merges(s.mainId)).toHaveLength(1);
  // The next merge starts from what was merged.
  await write(s.ver['intro.tex'], 'Intro by version.\n');
  await write(s.main['body.tex'], 'Alpha by main.\n\nBeta two.\n\nGamma by version.\n');
  const next = await plan(s.mainId, s.verId);
  expect(next.base.revision).toBe(p.source.revision);
  await merge(s, next);
  expect(await textOf(s.main['intro.tex'])).toBe('Intro by version.\n');
  expect(await textOf(s.main['body.tex'])).toBe(
    'Alpha by main.\n\nBeta two.\n\nGamma by version.\n',
  );
  expect(await merges(s.mainId)).toHaveLength(2);
});

test('editors are told after the edits, as of a restore, and read a merge from the note', async () => {
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const heard: { channel: string; payload: string }[] = [];
  const client = new pg.Client({ connectionString: t.url });
  await client.connect();
  client.on('notification', (n) => heard.push({ channel: n.channel, payload: n.payload ?? '' }));
  for (const channel of ['restored', 'file_edits']) await client.query(`listen "${channel}"`);
  try {
    const p = await plan(s.mainId, s.verId);
    heard.length = 0;
    const made = await merge(s, p);
    for (let i = 0; i < 50 && !heard.some((h) => h.channel === 'restored'); i++)
      await new Promise((r) => setTimeout(r, 40));
    const said = heard.findIndex((h) => h.channel === 'restored');
    expect(heard[said].payload).toBe(`${s.mainId}:${made.number}`);
    expect(heard.filter((h) => h.channel === 'restored')).toHaveLength(1);
    const edit = heard.findIndex(
      (h) => h.channel === 'file_edits' && h.payload.startsWith(`${s.main['body.tex']}:`),
    );
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(edit).toBeLessThan(said);

    // The note a reconnecting editor is given: the newest rewrite of the paper, a merge.
    const note = await lastRestoreNote(t.pool, users.viewer.id, s.main['body.tex']);
    expect(note).toMatchObject({
      id: made.id,
      number: made.number,
      by: users.owner.email,
      kept: made.kept,
      merge: { paper: s.verId, version: 'camera-ready', revision: p.source.number },
    });
    expect(await restoreNote(t.pool, s.mainId, made.number)).toEqual(note);
  } finally {
    await client.end();
  }
});

test("a second person's typing through a merge lands, whole, where they typed", async () => {
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha by version.\n\nBeta two.\n\nGamma three.\n');
  const p = await plan(s.mainId, s.verId);
  // Their editor has the paper as it is now, and the merge has not reached it yet.
  const { doc: theirs, text: theirText } = await docOf(s.main['body.tex']);
  await merge(s, p);
  const at = theirText.toString().indexOf('Gamma ') + 6;
  const sent: Uint8Array[] = [];
  theirs.on('update', (u: Uint8Array) => sent.push(u));
  for (const [i, letter] of [...'abcdefgh'].entries()) theirText.insert(at + i, letter);
  for (const u of sent) await appendUpdate(t.pool, s.main['body.tex'], users.editor.id, u);
  expect(await textOf(s.main['body.tex'])).toBe(
    'Alpha by version.\n\nBeta two.\n\nGamma abcdefghthree.\n',
  );
});

type Seen = { sql: string; tx: boolean };
/** The pool, noting every statement; `inTx` sees those made in a transaction as they are sent. */
function watched(seen: Seen[], inTx?: (sql: string) => void) {
  const mine = (target: object, prop: string | symbol) => {
    const v = Reflect.get(target, prop);
    return typeof v === 'function' ? v.bind(target) : v;
  };
  return new Proxy(t.pool, {
    get(target, prop) {
      if (prop === 'query')
        return (sql: string, params?: unknown[]) => (
          seen.push({ sql, tx: false }),
          target.query(sql, params)
        );
      if (prop === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get: (c, p) =>
              p === 'query'
                ? (sql: string, params?: unknown[]) => (
                    seen.push({ sql, tx: true }),
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FILES = 30;
const original = (i: number) => `one ${i} alpha\n\ntwo beta\n\nthree gamma\n`;
const bySide = (i: number) => `ONE ${i} ALPHA\n\ntwo beta\n\nthree GAMMA\n`;
const byMain = (i: number) => `one ${i} alpha\n\ntwo BETA\n\nthree gamma\n`;
const both = (i: number) => `ONE ${i} ALPHA\n\ntwo BETA\n\nthree GAMMA\n`;
const many = () =>
  Object.fromEntries(
    Array.from({ length: FILES }, (_, i) => [`f${String(i).padStart(2, '0')}.tex`, original(i)]),
  );

/** Thirty files merged from both sides, one added, one removed: what is done while they are held. */
async function measured(typedOnMain: boolean) {
  const s = await setup(many());
  const names = Object.keys(many());
  for (const [i, n] of names.entries()) await write(s.ver[n], bySide(i));
  // On the paper the files have been typed in (they have logs), or have never been opened.
  if (typedOnMain) for (const [i, n] of names.entries()) await write(s.main[n], byMain(i));
  await createFile(t.pool, store, users.owner.id, s.verId, 'new.tex', Buffer.from('new\n'));
  await deleteFile(t.pool, store, users.owner.id, s.verId, s.ver['intro.tex']);
  const p = await plan(s.mainId, s.verId);
  const seen: Seen[] = [];
  let held!: () => void;
  const locked = new Promise<void>((r) => (held = r));
  const spy = watched(seen, (sql) => /for update/.test(sql) && held());
  const merging = applyMerge(spy, store, users.owner.id, s.mainId, s.verId, ref(p), {});
  await locked;
  await sleep(50);
  const started = Date.now();
  // A file the merge does not touch, typed in while it holds the files.
  await editFile(t.pool, store, s.main['main.tex'], users.owner.id, (y) => y.insert(0, 'Q'));
  const waited = Date.now() - started;
  await merging;
  expect(waited).toBeLessThan(1500);
  for (const [i, n] of names.entries())
    expect(await textOf(s.main[n])).toBe(typedOnMain ? both(i) : bySide(i));
  expect(await textOf(s.main['main.tex'])).toBe('Q' + MAIN);
  expect(await paths(s.mainId)).toContain('new.tex');
  expect(await paths(s.mainId)).not.toContain('intro.tex');

  const tx = seen.filter((x) => x.tx);
  const held_ = tx.slice(tx.findIndex((x) => /for update/.test(x.sql)));
  expect(held_.at(-1)!.sql).toBe('commit');
  return { held: held_.length, reads: tx.filter((x) => /from file_updates/.test(x.sql)).length };
}

test('typing during a merge waits only while it writes, and the statements made then are few', async () => {
  // Typed on both sides: the edits are made ahead of time, and the files are held for a few
  // statements that do not grow with the number of files.
  const typed = await measured(true);
  process.stderr.write(`MEASURE with logs: ${typed.held} held, ${typed.reads} reads\n`);
  expect(typed.held).toBeLessThan(40);
  expect(typed.reads).toBeLessThan(6);
  // Never opened on the paper: each file begins its log while held, as for a restore.
  const fresh = await measured(false);
  process.stderr.write(`MEASURE never opened: ${fresh.held} held, ${fresh.reads} reads\n`);
});

test('a merge keeps what is anchored in text it did not change, as a restore does', async () => {
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const before = await docOf(s.main['body.tex']);
  const anchor = Y.createRelativePositionFromTypeIndex(
    before.text,
    before.text.toString().indexOf('Beta'),
    0,
  );
  const encoded = Y.encodeRelativePosition(anchor);
  await merge(s, await plan(s.mainId, s.verId));
  const after = await docOf(s.main['body.tex']);
  const abs = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(encoded),
    after.doc,
  );
  expect(abs?.index).toBe(after.text.toString().indexOf('Beta'));
});

test('the record of merges names both papers, and is read only by those who may read them', async () => {
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const into = await merge(s, await plan(s.mainId, s.verId));
  const p = await plan(s.verId, s.mainId);
  const up = await applyMerge(t.pool, store, users.owner.id, s.verId, s.mainId, ref(p), {});

  const [one] = await listMerges(t.pool, users.viewer.id, s.mainId);
  expect(one).toMatchObject({
    from: 'camera-ready',
    into: 'main',
    files: 1,
    conflicts: 0,
    by: users.owner.email,
    result: { id: into.id, number: into.number },
    kept: { id: into.kept.id, number: into.kept.number },
  });
  const [two] = await listMerges(t.pool, users.reviewer.id, s.verId);
  expect(two).toMatchObject({ from: 'main', into: 'camera-ready', result: { id: up.id } });
  // Only the paper's own merges, and not for a stranger.
  expect(await listMerges(t.pool, users.owner.id, s.mainId)).toHaveLength(1);
  const refused = await listMerges(t.pool, users.outsider.id, s.mainId).then(
    () => 'ok',
    (e) => e.code,
  );
  expect(refused).toBe('not_found');
  // A member of the paper who may not read the other one reads the merge but not its name.
  const alone = await t.signIn(`alone-merges${seq}@example.org`);
  await t.pool.query(
    'insert into project_members (project_id, user_id, role) values ($1, $2, $3)',
    [s.mainId, alone.id, 'viewer'],
  );
  expect((await listMerges(t.pool, alone.id, s.mainId))[0]).toMatchObject({
    from: null,
    into: 'main',
  });
});
