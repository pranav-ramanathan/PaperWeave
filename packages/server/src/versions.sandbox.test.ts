// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { approveDataset, datasetProposal } from './data.ts';
import { createFile, deleteFile } from './files.ts';
import { importZip, listFiles } from './import.ts';
import { productMetrics } from './metrics.ts';
import {
  acceptInvitation,
  deleteProject,
  invite,
  listMembers,
  listProjects,
  removeMember,
  setRole,
  transferOwnership,
} from './projects.ts';
import { cutRevision, listRevisions } from './revisions.ts';
import { editFile } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';
import {
  deleteVersion,
  listVersions,
  MAX_VERSIONS,
  renameVersion,
  sameFileIn,
  startVersion,
  versionsEnabled,
} from './versions.ts';

const store = blobStore(TEST_ENV);
const ON = { VERSIONS: '1' };
const MAIN =
  '\\documentclass{article}\n\\input{body}\n\\begin{document}\nHello.\n\\end{document}\n';
const BODY = '% body\n\\newcommand{\\x}{x}\n';
const CSV = 'day,ms\n1,10\n2,12\n';
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

/** A paper of the owner's, with the three other roles on it and a CSV file whose data is held back. */
async function paper() {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: 'body.tex', bytes: Buffer.from(BODY) },
    { path: 'data.csv', bytes: Buffer.from(CSV) },
    { path: 'fig.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  ]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, `Paper ${++seq}`);
  for (const role of ['editor', 'reviewer', 'viewer'] as const) {
    // Added directly: invitations are tested elsewhere, and many papers would meet their limits.
    await t.pool.query(
      'insert into project_members (project_id, user_id, role) values ($1, $2, $3)',
      [project.id, users[role].id, role],
    );
  }
  const files = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  const proposal = await datasetProposal(
    t.pool,
    store,
    users.owner.id,
    project.id,
    files['data.csv'],
  );
  await approveDataset(t.pool, store, users.owner.id, project.id, files['data.csv'], {
    version: proposal.version,
    columns: proposal.guess.columns,
    missing: [''],
    exported: false,
  });
  const revision = await cutRevision(t.pool, store, users.owner.id, project.id);
  return { id: project.id as string, files, revision: revision.id as string };
}

const filesOf = async (projectId: string) =>
  (
    await t.pool.query(
      'select id, path, digest, origin_id from files where project_id = $1 order by path',
      [projectId],
    )
  ).rows as { id: string; path: string; digest: string; origin_id: string | null }[];

const members = async (projectId: string) =>
  (
    await t.pool.query(
      'select user_id, role from project_members where project_id = $1 order by user_id',
      [projectId],
    )
  ).rows;

test('the VERSIONS setting is on for 1, off for 0 or nothing, and an error for anything else', () => {
  expect(versionsEnabled({})).toBe(false);
  expect(versionsEnabled({ VERSIONS: '' })).toBe(false);
  expect(versionsEnabled({ VERSIONS: '0' })).toBe(false);
  expect(versionsEnabled({ VERSIONS: ' 1 ' })).toBe(true);
  for (const bad of ['true', 'yes', '2', 'on'])
    expect(() => versionsEnabled({ VERSIONS: bad })).toThrow(/VERSIONS must be 1 or 0/);
});

test('with the setting off, no version is started, and nothing is made', async () => {
  const p = await paper();
  for (const env of [{}, { VERSIONS: '0' }])
    expect(
      await code(startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'x', { env })),
    ).toBe('not_found');
  expect((await t.pool.query('select 1 from projects where parent_id = $1', [p.id])).rowCount).toBe(
    0,
  );
});

test('a version is a paper of its own, begun at the revision, with files that have ids of their own', async () => {
  const p = await paper();
  const before = await filesOf(p.id);
  const v = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'camera-ready', {
    env: ON,
  });
  expect(v).toMatchObject({ name: 'camera-ready', revision: 1 });
  const copies = await filesOf(v.id);
  expect(copies.map((f) => [f.path, f.digest])).toEqual(before.map((f) => [f.path, f.digest]));
  // Own ids; the identity across versions is the origin, which is the main file's id.
  const mainIds = new Set(before.map((f) => f.id));
  expect(copies.every((f) => !mainIds.has(f.id))).toBe(true);
  expect(copies.map((f) => f.origin_id)).toEqual(before.map((f) => f.id));
  // The main paper's own files are as they were.
  expect(await filesOf(p.id)).toEqual(before);
  const row = (
    await t.pool.query(
      `select p.name, p.parent_id, p.version_name, p.base_revision_id, p.compiler, p.language,
              r.path as root, m.name as main_name, m.compiler as main_compiler, m.language as main_language
       from projects p left join files r on r.id = p.root_file_id
       join projects m on m.id = p.parent_id where p.id = $1`,
      [v.id],
    )
  ).rows[0];
  expect(row).toMatchObject({
    parent_id: p.id,
    version_name: 'camera-ready',
    base_revision_id: p.revision,
    root: 'main.tex',
    name: row.main_name,
    compiler: row.main_compiler,
    language: row.main_language,
  });
  // Revision 1 of the version holds the same files, each at the new id.
  const first = (await listRevisions(t.pool, users.owner.id, v.id))[0];
  expect(first.number).toBe(1);
  const frozen = await t.pool.query(
    'select file_id, path from revision_files where revision_id = $1 order by path',
    [first.id],
  );
  expect(frozen.rows.map((r) => [r.file_id, r.path])).toEqual(copies.map((f) => [f.id, f.path]));
  // A second version shares no file ids with the first, but the same origins.
  const w = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'Reviewer B', {
    env: ON,
  });
  const others = await filesOf(w.id);
  expect(others.some((f) => copies.some((c) => c.id === f.id))).toBe(false);
  expect(others.map((f) => f.origin_id)).toEqual(copies.map((f) => f.origin_id));
});

test('it begins at the revision asked for, not at the paper as it is now', async () => {
  const p = await paper();
  const was = (await filesOf(p.id)).find((f) => f.path === 'body.tex')!;
  await editFile(t.pool, store, p.files['body.tex'], users.owner.id, (text) => {
    text.insert(0, 'changed ');
  });
  const now = await cutRevision(t.pool, store, users.owner.id, p.id);
  expect(now.id).not.toBe(p.revision);
  const v = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'early', {
    env: ON,
  });
  expect((await filesOf(v.id)).find((f) => f.path === 'body.tex')!.digest).toBe(was.digest);
  const w = await startVersion(t.pool, store, users.owner.id, p.id, now.id, 'late', { env: ON });
  expect((await filesOf(w.id)).find((f) => f.path === 'body.tex')!.digest).not.toBe(was.digest);
  // Nobody's edit log is copied: a version's file has no log until it is first opened.
  expect(
    (
      await t.pool.query(
        'select count(*)::int as n from file_updates where file_id = any($1::uuid[])',
        [(await filesOf(v.id)).map((f) => f.id)],
      )
    ).rows[0].n,
  ).toBe(0);
  // Another revision's id, or a made-up one, is no revision of this paper.
  const other = await paper();
  expect(
    await code(startVersion(t.pool, store, users.owner.id, p.id, other.revision, 'x', { env: ON })),
  ).toBe('not_found');
  expect(
    await code(startVersion(t.pool, store, users.owner.id, p.id, 'nope', 'x', { env: ON })),
  ).toBe('not_found');
});

test('held data stays held on a version, and its description comes with it', async () => {
  const p = await paper();
  const v = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'held', {
    env: ON,
  });
  const copy = (await filesOf(v.id)).find((f) => f.path === 'data.csv')!;
  const rows = (await t.pool.query('select * from datasets where project_id = $1', [v.id])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ file_id: copy.id, exported: false });
  const main = (await t.pool.query('select * from datasets where project_id = $1', [p.id])).rows[0];
  expect(rows[0].approved_digest).toBe(main.approved_digest);
  expect(rows[0].columns).toEqual(main.columns);
});

test('a version has the same people and roles, and is listed with its paper and not among papers', async () => {
  const p = await paper();
  const v = await startVersion(t.pool, store, users.editor.id, p.id, p.revision, 'by editor', {
    env: ON,
  });
  expect(await members(v.id)).toEqual(await members(p.id));
  const mine = await listProjects(t.pool, users.owner.id);
  expect(mine.map((x) => x.id)).toContain(p.id);
  expect(mine.map((x) => x.id)).not.toContain(v.id);
  const listed = await listVersions(t.pool, users.viewer.id, p.id);
  expect(listed).toMatchObject([
    {
      id: v.id,
      paper: p.id,
      name: 'by editor',
      createdBy: users.editor.email,
      base: { number: 1 },
    },
  ]);
  // Asked of the version, it answers for the paper.
  expect(await listVersions(t.pool, users.viewer.id, v.id)).toEqual(listed);
  // Product metrics count papers, not versions.
  const count = (await productMetrics(t.pool)).papers.reduce((n, r) => n + r.papers, 0);
  const all = (await t.pool.query('select count(*)::int as n from projects')).rows[0].n;
  expect(count).toBeLessThan(all);
  expect(count).toBe(
    (await t.pool.query('select count(*)::int as n from projects where parent_id is null')).rows[0]
      .n,
  );
});

test('who may start, see, rename and delete a version, by role', async () => {
  const p = await paper();
  const mine = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'existing', {
    env: ON,
  });
  const want = {
    owner: { start: 'ok', list: 'ok', rename: 'ok' },
    editor: { start: 'ok', list: 'ok', rename: 'ok' },
    reviewer: { start: 'permission_denied', list: 'ok', rename: 'permission_denied' },
    viewer: { start: 'permission_denied', list: 'ok', rename: 'permission_denied' },
    outsider: { start: 'not_found', list: 'not_found', rename: 'not_found' },
  } as const;
  for (const [role, expected] of Object.entries(want) as [
    keyof typeof want,
    (typeof want)[keyof typeof want],
  ][]) {
    const u = users[role];
    expect(
      await code(startVersion(t.pool, store, u.id, p.id, p.revision, `by ${role}`, { env: ON })),
      `${role} start`,
    ).toBe(expected.start);
    expect(await code(listVersions(t.pool, u.id, p.id)), `${role} list`).toBe(expected.list);
    expect(
      await code(renameVersion(t.pool, u.id, mine.id, `renamed by ${role}`)),
      `${role} rename`,
    ).toBe(expected.rename);
  }
  // Deleting is the owner's alone, with the name typed.
  const current = (await listVersions(t.pool, users.owner.id, p.id)).find((v) => v.id === mine.id)!;
  for (const role of ['editor', 'reviewer', 'viewer'] as const)
    expect(await code(deleteVersion(t.pool, users[role].id, mine.id, current.name)), role).toBe(
      'permission_denied',
    );
  expect(await code(deleteVersion(t.pool, users.outsider.id, mine.id, current.name))).toBe(
    'not_found',
  );
  expect((await listVersions(t.pool, users.owner.id, p.id)).some((v) => v.id === mine.id)).toBe(
    true,
  );
});

test("one paper's people cannot reach another paper's versions", async () => {
  const a = await paper();
  const b = await paper();
  const mineInA = await startVersion(t.pool, store, users.owner.id, a.id, a.revision, 'a1', {
    env: ON,
  });
  // A stranger to A (a member of B only) has nothing of A.
  const stranger = await t.signIn(`stranger${++seq}@example.org`);
  const { token } = await invite(t.pool, users.owner.id, b.id, stranger.email, 'editor');
  await acceptInvitation(t.pool, stranger.id, token);
  expect(await code(listVersions(t.pool, stranger.id, a.id))).toBe('not_found');
  expect(await code(listVersions(t.pool, stranger.id, mineInA.id))).toBe('not_found');
  expect(await code(renameVersion(t.pool, stranger.id, mineInA.id, 'mine'))).toBe('not_found');
  expect(await code(deleteVersion(t.pool, stranger.id, mineInA.id, 'a1'))).toBe('not_found');
  expect(
    await code(startVersion(t.pool, store, stranger.id, a.id, a.revision, 'x', { env: ON })),
  ).toBe('not_found');
  // Nor is a revision of A a revision of B, even for someone who is on both.
  expect(
    await code(startVersion(t.pool, store, users.owner.id, b.id, a.revision, 'x', { env: ON })),
  ).toBe('not_found');
  // A made-up id is the same answer as an id that is not theirs.
  expect(await code(listVersions(t.pool, stranger.id, 'not-an-id'))).toBe('not_found');
  expect(await code(deleteVersion(t.pool, users.owner.id, 'not-an-id', 'x'))).toBe('not_found');
  // The stranger is on B only, and B's versions are not A's.
  expect(await listVersions(t.pool, stranger.id, b.id)).toEqual([]);
});

test('names: one line of up to 60 characters, not "main", and one to a paper whatever the capitals', async () => {
  const p = await paper();
  const start = (name: unknown) =>
    code(startVersion(t.pool, store, users.owner.id, p.id, p.revision, name, { env: ON }));
  expect(await start('')).toBe('invalid_input');
  expect(await start('   ')).toBe('invalid_input');
  expect(await start('x'.repeat(61))).toBe('invalid_input');
  expect(await start('two\nlines')).toBe('invalid_input');
  expect(await start('Main')).toBe('invalid_input');
  expect(await start(42)).toBe('invalid_input');
  expect(await start('x'.repeat(60))).toBe('ok');
  expect(await start(' Camera-ready ')).toBe('ok');
  expect(await start('camera-READY')).toBe('conflict');
  const [, second] = await listVersions(t.pool, users.owner.id, p.id);
  expect(second.name).toBe('Camera-ready');
  expect(await code(renameVersion(t.pool, users.owner.id, second.id, 'x'.repeat(60)))).toBe(
    'conflict',
  );
  expect(await code(renameVersion(t.pool, users.owner.id, second.id, 'CAMERA-ready'))).toBe('ok');
  expect(await code(renameVersion(t.pool, users.owner.id, p.id, 'x'))).toBe('invalid_input');
  expect((await listVersions(t.pool, users.owner.id, p.id)).map((v) => v.name)).toContain(
    'CAMERA-ready',
  );
});

test('a paper has at most ten versions; deleting one makes room', async () => {
  const p = await paper();
  for (let i = 1; i <= MAX_VERSIONS; i++)
    await startVersion(t.pool, store, users.owner.id, p.id, p.revision, `v${i}`, { env: ON });
  expect(
    await code(
      startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'eleventh', { env: ON }),
    ),
  ).toBe('conflict');
  const [first] = await listVersions(t.pool, users.owner.id, p.id);
  expect(await listVersions(t.pool, users.owner.id, p.id)).toHaveLength(MAX_VERSIONS);
  await deleteVersion(t.pool, users.owner.id, first.id, first.name);
  expect(
    await code(
      startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'eleventh', { env: ON }),
    ),
  ).toBe('ok');
  // Another paper has its own ten.
  const q = await paper();
  expect(
    await code(startVersion(t.pool, store, users.owner.id, q.id, q.revision, 'v1', { env: ON })),
  ).toBe('ok');
});

test('there is no version of a version', async () => {
  const p = await paper();
  const v = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'one', { env: ON });
  const inner = (await listRevisions(t.pool, users.owner.id, v.id))[0];
  expect(
    await code(startVersion(t.pool, store, users.owner.id, v.id, inner.id, 'two', { env: ON })),
  ).toBe('invalid_input');
});

test('deleting a version removes it and leaves the paper and its other versions as they were', async () => {
  const p = await paper();
  const v = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'doomed', {
    env: ON,
  });
  const keep = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'kept', {
    env: ON,
  });
  const state = async (id: string) => ({
    files: await filesOf(id),
    members: await members(id),
    revisions: (
      await t.pool.query('select id, number from revisions where project_id = $1 order by number', [
        id,
      ])
    ).rows,
    datasets: (
      await t.pool.query('select file_id from datasets where project_id = $1 order by file_id', [
        id,
      ])
    ).rows,
  });
  const [mainBefore, keepBefore] = [await state(p.id), await state(keep.id)];
  // Only the exact name, and only for a version.
  expect(await code(deleteVersion(t.pool, users.owner.id, v.id, 'Doomed'))).toBe('invalid_input');
  expect(await code(deleteVersion(t.pool, users.owner.id, v.id, ''))).toBe('invalid_input');
  expect(await code(deleteVersion(t.pool, users.owner.id, p.id, 'x'))).toBe('invalid_input');
  expect((await t.pool.query('select 1 from projects where id = $1', [v.id])).rowCount).toBe(1);
  expect(await deleteVersion(t.pool, users.owner.id, v.id, 'doomed')).toEqual({ name: 'doomed' });
  expect((await t.pool.query('select 1 from projects where id = $1', [v.id])).rowCount).toBe(0);
  for (const table of ['all_files', 'revisions', 'project_members', 'datasets'])
    expect(
      (await t.pool.query(`select 1 from ${table} where project_id = $1`, [v.id])).rowCount,
      table,
    ).toBe(0);
  expect(await state(p.id)).toEqual(mainBefore);
  expect(await state(keep.id)).toEqual(keepBefore);
  expect((await listVersions(t.pool, users.owner.id, p.id)).map((x) => x.name)).toEqual(['kept']);
  // A version is deleted as a version, never as a paper.
  expect(await code(deleteProject(t.pool, users.owner.id, keep.id, 'kept'))).toBe('invalid_input');
});

test('deleting the paper deletes its versions, and tells the editors of each', async () => {
  const p = await paper();
  const v = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'goes too', {
    env: ON,
  });
  const name = (await t.pool.query('select name from projects where id = $1', [p.id])).rows[0].name;
  const heard: string[] = [];
  const listener = await t.pool.connect();
  listener.on('notification', (n) => heard.push(n.payload ?? ''));
  await listener.query('listen acl');
  await deleteProject(t.pool, users.owner.id, p.id, name);
  await new Promise((r) => setTimeout(r, 200));
  listener.release();
  expect(
    (await t.pool.query('select 1 from projects where id = any($1)', [[p.id, v.id]])).rowCount,
  ).toBe(0);
  expect(heard).toEqual(expect.arrayContaining([p.id, v.id]));
});

test('member changes on the paper are made to every version of it, in one go', async () => {
  const p = await paper();
  const v = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'one', { env: ON });
  const w = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'two', { env: ON });
  const roleOn = async (project: string, user: string) =>
    (
      await t.pool.query(
        'select role from project_members where project_id = $1 and user_id = $2',
        [project, user],
      )
    ).rows[0]?.role;
  const everywhere = async (user: string) => [p.id, v.id, w.id].map((id) => roleOn(id, user));
  const heard: string[] = [];
  const listener = await t.pool.connect();
  listener.on('notification', (n) => heard.push(n.payload ?? ''));
  await listener.query('listen acl');

  // Accepting an invitation puts the person on the paper and on each version, in the role invited.
  const guest = await t.signIn(`guest${++seq}@example.org`);
  const { token } = await invite(t.pool, users.owner.id, p.id, guest.email, 'reviewer');
  await acceptInvitation(t.pool, guest.id, token);
  expect(await Promise.all(await everywhere(guest.id))).toEqual([
    'reviewer',
    'reviewer',
    'reviewer',
  ]);
  // A version started later has them too.
  const later = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'three', {
    env: ON,
  });
  expect(await roleOn(later.id, guest.id)).toBe('reviewer');

  // A role changes everywhere, and every paper's editors are told.
  heard.length = 0;
  await setRole(t.pool, users.owner.id, p.id, guest.id, 'editor');
  expect(await Promise.all(await everywhere(guest.id))).toEqual(['editor', 'editor', 'editor']);
  await new Promise((r) => setTimeout(r, 200));
  expect([...new Set(heard)].sort()).toEqual([p.id, v.id, w.id, later.id].sort());
  // Asked of a version, the same: the people are the paper's.
  await setRole(t.pool, users.owner.id, w.id, guest.id, 'viewer');
  expect(await Promise.all(await everywhere(guest.id))).toEqual(['viewer', 'viewer', 'viewer']);

  // Ownership changes hands on every paper at once, and no version is left without an owner.
  await transferOwnership(t.pool, users.owner.id, p.id, users.editor.id);
  for (const id of [p.id, v.id, w.id, later.id]) {
    expect(await roleOn(id, users.editor.id), id).toBe('owner');
    expect(await roleOn(id, users.owner.id), id).toBe('editor');
  }
  // The new owner's decision alone, and the old one may not hand it again.
  expect(await code(transferOwnership(t.pool, users.owner.id, p.id, guest.id))).toBe(
    'permission_denied',
  );
  // Someone missing from a version stops a hand-over, and nothing is changed.
  await t.pool.query('delete from project_members where project_id = $1 and user_id = $2', [
    v.id,
    guest.id,
  ]);
  expect(await code(transferOwnership(t.pool, users.editor.id, p.id, guest.id))).toBe(
    'invalid_input',
  );
  expect(await roleOn(p.id, users.editor.id)).toBe('owner');
  expect(await roleOn(w.id, users.editor.id)).toBe('owner');
  await t.pool.query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'viewer')",
    [v.id, guest.id],
  );

  // Removing someone removes them from every version.
  await removeMember(t.pool, users.editor.id, p.id, guest.id);
  expect(await Promise.all(await everywhere(guest.id))).toEqual([undefined, undefined, undefined]);
  expect(await roleOn(later.id, guest.id)).toBeUndefined();
  // Someone may leave from a version, and leaves the paper too.
  await removeMember(t.pool, users.viewer.id, v.id, users.viewer.id);
  expect(await Promise.all(await everywhere(users.viewer.id))).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  listener.release();

  // At every moment the versions have the people of their paper.
  for (const id of [v.id, w.id, later.id]) expect(await members(id)).toEqual(await members(p.id));
  expect((await listMembers(t.pool, users.editor.id, v.id)).map((m) => m.email).sort()).toEqual(
    (await listMembers(t.pool, users.editor.id, p.id)).map((m) => m.email).sort(),
  );
});

test('a version starts without the paper’s comments and proposals, and its files can be edited', async () => {
  const p = await paper();
  const v = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'clean', {
    env: ON,
  });
  for (const table of ['threads', 'proposals'])
    expect(
      (await t.pool.query(`select 1 from ${table} where project_id = $1`, [v.id])).rowCount,
      table,
    ).toBe(0);
  // A file of a version is edited like any other, and the paper's file does not move.
  const body = (await filesOf(v.id)).find((f) => f.path === 'body.tex')!;
  const main = p.files['body.tex'];
  await editFile(t.pool, store, body.id, users.owner.id, (text) => {
    text.insert(0, 'x');
  });
  expect(
    (await t.pool.query('select head_seq from files where id = $1', [main])).rows[0].head_seq,
  ).toBe('0');
  expect(
    Number(
      (await t.pool.query('select head_seq from files where id = $1', [body.id])).rows[0].head_seq,
    ),
  ).toBeGreaterThan(0);
});

test('sameFileIn finds a file in the other papers of the family by origin, and by role', async () => {
  const p = await paper();
  const v = await startVersion(t.pool, store, users.owner.id, p.id, p.revision, 'same-file', {
    env: ON,
  });
  const inVersion = Object.fromEntries((await filesOf(v.id)).map((f) => [f.path, f.id]));
  // Main to the version, and the version to main: each maps the family, itself included.
  const fromMain = await sameFileIn(t.pool, users.owner.id, p.id, p.files['body.tex']);
  expect(Object.fromEntries(fromMain)).toEqual({
    [p.id]: p.files['body.tex'],
    [v.id]: inVersion['body.tex'],
  });
  const fromVersion = await sameFileIn(t.pool, users.owner.id, v.id, inVersion['body.tex']);
  expect(Object.fromEntries(fromVersion)).toEqual(Object.fromEntries(fromMain));

  // A file made in the version has no match in main; one made in main after the version has none
  // in the version.
  const mine = await createFile(t.pool, store, users.owner.id, v.id, 'only-here.tex');
  expect([...(await sameFileIn(t.pool, users.owner.id, v.id, mine)).keys()]).toEqual([v.id]);
  const later = await createFile(t.pool, store, users.owner.id, p.id, 'later.tex');
  expect([...(await sameFileIn(t.pool, users.owner.id, p.id, later)).keys()]).toEqual([p.id]);

  // A deleted file is not matched, from either side.
  await deleteFile(t.pool, store, users.owner.id, v.id, inVersion['body.tex']);
  const afterDelete = await sameFileIn(t.pool, users.owner.id, p.id, p.files['body.tex']);
  expect([...afterDelete.keys()]).toEqual([p.id]);
  expect((await sameFileIn(t.pool, users.owner.id, v.id, inVersion['body.tex'])).size).toBe(0);

  // A file of another paper is not found under this paper's address.
  expect((await sameFileIn(t.pool, users.owner.id, v.id, p.files['data.csv'])).size).toBe(0);

  // Everyone on the paper may ask (project.read); a stranger is told there is no such paper.
  for (const role of ['owner', 'editor', 'reviewer', 'viewer'] as const)
    expect(await code(sameFileIn(t.pool, users[role].id, p.id, p.files['main.tex'])), role).toBe(
      'ok',
    );
  expect(await code(sameFileIn(t.pool, users.outsider.id, p.id, p.files['main.tex']))).toBe(
    'not_found',
  );
});
