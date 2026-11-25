// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { createFile, deleteFile, replaceFile } from './files.ts';
import { importZip, listFiles } from './import.ts';
import { compareAcross, planMerge, settleFile, type MergePlan } from './merge.ts';
import { cutRevision, diffRevisions, renameFile } from './revisions.ts';
import { editFile } from './sync.ts';
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

/** A paper, a version of it begun at its first revision, and the file ids on both sides by path. */
async function setup() {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: 'body.tex', bytes: Buffer.from(BODY) },
    { path: 'intro.tex', bytes: Buffer.from(INTRO) },
    { path: 'fig.png', bytes: PNG(1) },
  ]);
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
    {
      env: ON,
    },
  );
  const ver = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, v.id)).map((f) => [f.path, f.id as string]),
  );
  return { main, ver, mainId: project.id as string, verId: v.id as string, first: first.id };
}

const write = (fileId: string, text: string, who = users.owner) =>
  editFile(t.pool, store, fileId, who.id, (y) => {
    y.delete(0, y.length);
    y.insert(0, text);
  });

const plan = (target: string, source: string, who = users.owner) =>
  planMerge(t.pool, store, who.id, target, source);
const at = (p: MergePlan, path: string) => p.files.find((f) => f.path === path)!;

test('changes in different files are each kept or taken, and the rest is unchanged', async () => {
  const s = await setup();
  await write(s.main['intro.tex'], 'Intro by main.\n');
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const p = await plan(s.mainId, s.verId);
  expect(at(p, 'intro.tex')).toMatchObject({ status: 'kept', content: 'ours', touches: false });
  expect(at(p, 'body.tex')).toMatchObject({ status: 'taken', content: 'theirs', touches: true });
  expect(at(p, 'main.tex').status).toBe('unchanged');
  expect(at(p, 'fig.png').status).toBe('unchanged');
  expect(p.conflicts).toEqual([]);
  expect(p.counts).toMatchObject({ kept: 1, taken: 1, unchanged: 2, conflicts: 0 });
  expect(p.settings.root.status).toBe('unchanged');
});

test('changes to different paragraphs of one file merge by themselves', async () => {
  const s = await setup();
  await write(s.main['body.tex'], 'Alpha by main.\n\nBeta two.\n\nGamma three.\n');
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const p = await plan(s.mainId, s.verId);
  const body = at(p, 'body.tex');
  expect(body).toMatchObject({
    status: 'merged',
    content: 'merged',
    text: 'Alpha by main.\n\nBeta two.\n\nGamma by version.\n',
    touches: true,
  });
  expect(p.conflicts).toEqual([]);
});

test('both sides changing one paragraph is a conflict with the three texts, and can be settled', async () => {
  const s = await setup();
  await write(s.main['body.tex'], 'Alpha one.\n\nBeta by main.\n\nGamma three.\n');
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta by version.\n\nGamma three.\n');
  const p = await plan(s.mainId, s.verId);
  const body = at(p, 'body.tex');
  expect(body.status).toBe('conflict');
  expect(p.conflicts).toHaveLength(1);
  const c = p.conflicts[0];
  expect(c).toMatchObject({
    id: `${body.key}#1`,
    kind: 'text',
    textKind: 'both-changed',
    line: 3,
    base: expect.stringContaining('two'),
    ours: expect.stringContaining('main'),
    theirs: expect.stringContaining('version'),
    choices: ['ours', 'theirs', 'both', 'base', 'text'],
  });
  // The offsets say where each side's stretch sits in its own text.
  const ours = 'Alpha one.\n\nBeta by main.\n\nGamma three.\n';
  expect(ours.slice(...c.offsets!.ours)).toBe(c.ours);
  expect(BODY.slice(...c.offsets!.base)).toBe(c.base);
  expect(settleFile(body, { [c.id]: 'theirs' })).toContain('Beta by version.');
  expect(settleFile(body, { [c.id]: 'ours' })).toContain('Beta by main.');
  expect(settleFile(body, { [c.id]: { text: 'Mine.' } })).toContain('Mine.');
  expect(() => settleFile(body, {})).toThrow(/No choice/);
  // The same three revisions give the same ids when asked again.
  expect((await plan(s.mainId, s.verId)).conflicts.map((x) => x.id)).toEqual([c.id]);
});

test('a picture changed on both sides is a choice of a side, never merged', async () => {
  const s = await setup();
  await replaceFile(t.pool, store, users.owner.id, s.mainId, 'fig.png', PNG(7));
  await replaceFile(t.pool, store, users.owner.id, s.verId, 'fig.png', PNG(8));
  const p = await plan(s.mainId, s.verId);
  expect(at(p, 'fig.png').status).toBe('conflict');
  expect(p.conflicts).toEqual([
    expect.objectContaining({ kind: 'binary', choices: ['ours', 'theirs'], path: 'fig.png' }),
  ]);
  // Changed on one side only: taken.
  const q = await setup();
  await replaceFile(t.pool, store, users.owner.id, q.verId, 'fig.png', PNG(9));
  expect(at(await plan(q.mainId, q.verId), 'fig.png').status).toBe('taken');
});

test('files added, deleted and renamed on either side', async () => {
  const s = await setup();
  await createFile(t.pool, store, users.owner.id, s.verId, 'extra.tex', Buffer.from('extra\n'));
  await createFile(t.pool, store, users.owner.id, s.mainId, 'mine.tex', Buffer.from('mine\n'));
  await deleteFile(t.pool, store, users.owner.id, s.verId, s.ver['intro.tex']);
  // Renamed on the version, edited on main: both.
  await renameFile(t.pool, users.owner.id, s.verId, s.ver['body.tex'], 'chapter.tex');
  await write(s.main['body.tex'], 'Alpha by main.\n\nBeta two.\n\nGamma three.\n');
  const p = await plan(s.mainId, s.verId);
  expect(at(p, 'extra.tex')).toMatchObject({ status: 'added', content: 'theirs', target: null });
  expect(at(p, 'mine.tex')).toMatchObject({ status: 'kept', source: null });
  expect(at(p, 'intro.tex')).toMatchObject({ status: 'removed', content: 'none', touches: true });
  expect(at(p, 'chapter.tex')).toMatchObject({
    status: 'taken',
    content: 'ours',
    was: 'body.tex',
    renamed: { from: 'body.tex', to: 'chapter.tex', side: 'theirs' },
  });
  expect(p.files.some((f) => f.path === 'body.tex')).toBe(false);
  expect(p.conflicts).toEqual([]);

  // Deleted on one side and changed on the other is a decision, either way round.
  const u = await setup();
  await deleteFile(t.pool, store, users.owner.id, u.verId, u.ver['intro.tex']);
  await write(u.main['intro.tex'], 'Intro by main.\n');
  const q = await plan(u.mainId, u.verId);
  expect(q.conflicts).toEqual([
    expect.objectContaining({ kind: 'deleted-vs-changed', path: 'intro.tex', theirsFile: null }),
  ]);
  const r = await plan(u.verId, u.mainId);
  expect(r.conflicts).toEqual([
    expect.objectContaining({ kind: 'deleted-vs-changed', path: 'intro.tex', oursFile: null }),
  ]);

  // Renamed to different names on both sides.
  const w = await setup();
  await renameFile(t.pool, users.owner.id, w.mainId, w.main['intro.tex'], 'a.tex');
  await renameFile(t.pool, users.owner.id, w.verId, w.ver['intro.tex'], 'b.tex');
  expect((await plan(w.mainId, w.verId)).conflicts).toEqual([
    expect.objectContaining({ kind: 'renamed' }),
  ]);

  // A file the source adds at a path the target's other file has.
  const x = await setup();
  await deleteFile(t.pool, store, users.owner.id, x.mainId, x.main['intro.tex']);
  await createFile(t.pool, store, users.owner.id, x.mainId, 'extra.tex', Buffer.from('m\n'));
  await createFile(t.pool, store, users.owner.id, x.verId, 'extra.tex', Buffer.from('v\n'));
  // Both new at one path, different text: two stretches to merge from nothing.
  const both = await plan(x.mainId, x.verId);
  expect(at(both, 'extra.tex').status).toBe('conflict');
  // The same bytes at one path are one file.
  const y = await setup();
  await createFile(t.pool, store, users.owner.id, y.mainId, 'same.tex', Buffer.from('s\n'));
  await createFile(t.pool, store, users.owner.id, y.verId, 'same.tex', Buffer.from('s\n'));
  expect(at(await plan(y.mainId, y.verId), 'same.tex').status).toBe('unchanged');
});

test('the plan goes both ways: the version into main, and main into the version', async () => {
  const s = await setup();
  await write(s.main['intro.tex'], 'Intro by main.\n');
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const into = await plan(s.mainId, s.verId);
  const up = await plan(s.verId, s.mainId);
  expect(into.target.paper).toBe(s.mainId);
  expect(up.target.paper).toBe(s.verId);
  expect(up.source.paper).toBe(s.mainId);
  // The same base both ways.
  expect(up.base.revision).toBe(into.base.revision);
  expect(at(into, 'intro.tex').status).toBe('kept');
  expect(at(up, 'intro.tex').status).toBe('taken');
  expect(at(into, 'body.tex').status).toBe('taken');
  expect(at(up, 'body.tex').status).toBe('kept');
  // Conflicts swap sides.
  await write(s.main['body.tex'], 'Alpha one.\n\nBeta by main.\n\nGamma three.\n');
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta by version.\n\nGamma three.\n');
  const a = (await plan(s.mainId, s.verId)).conflicts[0];
  const b = (await plan(s.verId, s.mainId)).conflicts[0];
  expect([a.ours, a.theirs]).toEqual([b.theirs, b.ours]);
});

test('papers not of one family, outsiders, and people who may not write are refused', async () => {
  const s = await setup();
  const other = await setup();
  const sibling = await startVersion(t.pool, store, users.owner.id, s.mainId, s.first, 'second', {
    env: ON,
  });
  expect(await code(plan(s.mainId, other.mainId))).toBe('invalid_input');
  expect(await code(plan(s.mainId, other.verId))).toBe('invalid_input');
  expect(await code(plan(s.verId, sibling.id))).toBe('invalid_input');
  expect(await code(plan(s.mainId, s.mainId))).toBe('invalid_input');
  expect(await code(plan(s.mainId, s.verId, users.outsider))).toBe('not_found');
  expect(await code(plan(s.verId, s.mainId, users.outsider))).toBe('not_found');
  expect(await code(plan(s.mainId, s.verId, users.viewer))).toBe('permission_denied');
  expect(await code(plan(s.mainId, s.verId, users.reviewer))).toBe('permission_denied');
  expect(await code(plan(s.mainId, s.verId, users.editor))).toBe('ok');
  // A member of one paper only does not learn that the other exists.
  const alone = await t.signIn(`alone${seq}@example.org`);
  await t.pool.query(
    'insert into project_members (project_id, user_id, role) values ($1, $2, $3)',
    [s.mainId, alone.id, 'editor'],
  );
  expect(await code(planMerge(t.pool, store, alone.id, s.mainId, other.mainId))).toBe('not_found');
  // Nothing was cut for any refusal beyond the allowed plans.
});

test('the plan records what the apply step needs to refuse a paper that moved', async () => {
  const s = await setup();
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta two.\n\nGamma by version.\n');
  const p = await plan(s.mainId, s.verId);
  const heads = async () =>
    Object.fromEntries(
      (
        await t.pool.query('select id, head_seq from files where project_id = $1', [s.mainId])
      ).rows.map((r) => [r.id, String(r.head_seq)]),
    );
  const now = await heads();
  // Every file of the target, with the place in its log the plan saw; the revision it was cut as.
  expect(Object.fromEntries(p.target.files.map((f) => [f.fileId, f.headSeq]))).toEqual(now);
  const body = at(p, 'body.tex');
  expect(body.target).toEqual({
    fileId: s.main['body.tex'],
    path: 'body.tex',
    headSeq: now[s.main['body.tex']],
  });
  expect(body.touches).toBe(true);
  expect(p.target.revision).toBeTruthy();
  expect(p.source.paper).toBe(s.verId);
  // Typing in the touched file after the plan moves the place, and the plan's record shows it.
  await write(s.main['body.tex'], 'Typed meanwhile.\n\nBeta two.\n\nGamma three.\n');
  const later = await heads();
  expect(later[s.main['body.tex']]).not.toBe(body.target!.headSeq);
  // Planning again sees the new place and cuts a new revision.
  const again = await plan(s.mainId, s.verId);
  expect(at(again, 'body.tex').target!.headSeq).toBe(later[s.main['body.tex']]);
  expect(again.target.revision).not.toBe(p.target.revision);
  expect(at(again, 'body.tex').status).toBe('merged');
});

test('comparing across versions pairs files by origin, so a renamed file is one file', async () => {
  const s = await setup();
  await renameFile(t.pool, users.owner.id, s.verId, s.ver['body.tex'], 'chapter.tex');
  await write(s.ver['body.tex'], 'Alpha one.\n\nBeta new.\n\nGamma three.\n');
  await createFile(t.pool, store, users.owner.id, s.verId, 'extra.tex', Buffer.from('extra\n'));
  const d = await compareAcross(
    t.pool,
    store,
    users.owner.id,
    { paper: s.mainId },
    { paper: s.verId },
  );
  expect(d.from.paper).toBe(s.mainId);
  expect(d.to.paper).toBe(s.verId);
  const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
  expect(Object.keys(by).sort()).toEqual(['chapter.tex', 'extra.tex']);
  expect(by['chapter.tex']).toMatchObject({ status: 'changed', was: 'body.tex' });
  expect(by['chapter.tex'].lines?.some((l) => l.op === '+' && l.text.includes('Beta new'))).toBe(
    true,
  );
  expect(by['extra.tex'].status).toBe('added');
  // A given revision of the version against main's first revision.
  const early = await compareAcross(
    t.pool,
    store,
    users.owner.id,
    { paper: s.mainId, revision: s.first },
    { paper: s.verId },
  );
  expect(early.files.map((f) => f.path)).toEqual(d.files.map((f) => f.path));
  // Anyone who reads both may compare; a viewer compares with the latest revisions there are.
  expect(
    await code(
      compareAcross(t.pool, store, users.viewer.id, { paper: s.mainId }, { paper: s.verId }),
    ),
  ).toBe('ok');
  // Refused: another family, a revision of the other paper, outsiders.
  const other = await setup();
  expect(
    await code(
      compareAcross(t.pool, store, users.owner.id, { paper: s.mainId }, { paper: other.verId }),
    ),
  ).toBe('invalid_input');
  expect(
    await code(
      compareAcross(
        t.pool,
        store,
        users.owner.id,
        { paper: s.mainId, revision: other.first },
        { paper: s.verId },
      ),
    ),
  ).toBe('not_found');
  expect(
    await code(
      compareAcross(t.pool, store, users.outsider.id, { paper: s.mainId }, { paper: s.verId }),
    ),
  ).toBe('not_found');
  // Within one paper it is the comparison diffRevisions makes.
  const one = await compareAcross(
    t.pool,
    store,
    users.owner.id,
    { paper: s.verId, revision: (await cutRevision(t.pool, store, users.owner.id, s.verId)).id },
    { paper: s.verId },
  );
  expect(one.files).toEqual([]);
  const rev = await cutRevision(t.pool, store, users.owner.id, s.mainId);
  expect(
    (await diffRevisions(t.pool, store, users.owner.id, s.mainId, s.first, rev.id)).files,
  ).toEqual([]);
});
