// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
// Bringing a version's open threads and proposals across on a merge (PLAN.md section 14, V9).
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { importZip, listFiles } from './import.ts';
import { applyMerge } from './merge-apply.ts';
import { type MergePlan, planMerge } from './merge.ts';
import { acceptProposal, closeProposal, listProposals, propose } from './proposals.ts';
import { cutRevision } from './revisions.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { listThreads, reply, setThreadStatus, startThread } from './threads.ts';
import { startVersion } from './versions.ts';

const store = blobStore(TEST_ENV);
const ON = { VERSIONS: '1' };
const MAIN = '\\documentclass{article}\n\\begin{document}\n\\input{body}\n\\end{document}\n';
const BODY = 'Alpha one.\n\nBeta two.\n\nGamma three.\n';
const INTRO = 'Intro text.\n';
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
async function setup(entries: Record<string, string> = {}) {
  const files = { 'main.tex': MAIN, 'body.tex': BODY, 'intro.tex': INTRO, ...entries };
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
  return { main, ver, mainId: project.id as string, verId: v.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

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
const merge = (s: Setup, p: MergePlan, carry = true, who = users.owner) =>
  applyMerge(t.pool, store, who.id, s.mainId, s.verId, ref(p), {}, {}, carry);

/** The two ends of a stretch of the saved text, as an editor would send them. */
async function ends(file: string, words: string) {
  const { text } = await docOf(file);
  const at = text.toString().indexOf(words);
  if (at < 0) throw new Error(`"${words}" is not in the file`);
  return {
    from: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, 0)),
    to: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, at + words.length, -1),
    ),
  };
}
const comment = async (s: Setup, words: string, body: string, who = users.reviewer) =>
  (
    await startThread(t.pool, store, who.id, s.verId, s.ver['body.tex'], {
      ...(await ends(s.ver['body.tex'], words)),
      body,
    })
  ).id;
const proposal = async (s: Setup, words: string, replacement: string, who = users.reviewer) =>
  propose(t.pool, store, who.id, s.verId, s.ver['body.tex'], {
    ...(await ends(s.ver['body.tex'], words)),
    replacement,
    reason: 'Clearer.',
  });
/** The version changes a file the paper did not touch, so that there is something to merge. */
const touch = (s: Setup, note: string) =>
  editFile(t.pool, store, s.ver['intro.tex'], users.owner.id, (y) => y.insert(y.length, note));
const onMain = (s: Setup, who = users.owner) => listThreads(t.pool, store, who.id, s.mainId);
const proposalsOnMain = (s: Setup, who = users.owner) =>
  listProposals(t.pool, store, who.id, s.mainId);

test('an open thread and proposal whose words survive arrive on the matching file, anchored to them', async () => {
  const s = await setup();
  const th = await comment(s, 'Beta two.', 'Is this the right order?');
  await reply(t.pool, users.editor.id, s.verId, th, { body: 'I think so.' });
  await proposal(s, 'Gamma three.', 'Gamma 3.');
  await touch(s, 'Version note.\n');
  const done = await merge(s, await plan(s.mainId, s.verId));
  expect(done.carried).toMatchObject({ threads: 1, proposals: 1, left: [] });
  // What the merge wrote is what it would have written: the version's note, and nothing else.
  expect(await textOf(s.main['intro.tex'])).toBe(`${INTRO}Version note.\n`);
  expect(await textOf(s.main['body.tex'])).toBe(BODY);
  const [thread] = await onMain(s);
  expect(thread).toMatchObject({
    fileId: s.main['body.tex'],
    path: 'body.tex',
    state: 'attached',
    now: 'Beta two.',
    status: 'open',
    startedBy: 'reviewer@example.org',
  });
  expect(thread.comments.map((c) => [c.author, c.body])).toEqual([
    ['reviewer@example.org', 'Is this the right order?'],
    ['editor@example.org', 'I think so.'],
  ]);
  const [prop] = await proposalsOnMain(s);
  expect(prop).toMatchObject({
    fileId: s.main['body.tex'],
    status: 'open',
    stale: false,
    now: 'Gamma three.',
    replacement: 'Gamma 3.',
    author: 'reviewer@example.org',
  });
  // It works where it stands: accepting it changes main's text.
  await acceptProposal(t.pool, store, users.owner.id, s.mainId, prop.id);
  expect(await textOf(s.main['body.tex'])).toContain('Gamma 3.');
  // The version keeps its own.
  expect(await listThreads(t.pool, store, users.owner.id, s.verId)).toHaveLength(1);
  expect((await listProposals(t.pool, store, users.owner.id, s.verId))[0].status).toBe('open');
});

test('one whose words did not survive is listed, stays on the version, and costs the merge nothing', async () => {
  const s = await setup();
  await comment(s, 'Beta two.', 'Cut this?');
  await proposal(s, 'Beta two.', 'Beta 2.');
  await comment(s, 'Gamma three.', 'Keep.');
  // The version deletes the stretch, so the merge takes the deletion.
  await editFile(t.pool, store, s.ver['body.tex'], users.owner.id, (y) => {
    const at = y.toString().indexOf('Beta two.\n\n');
    y.delete(at, 'Beta two.\n\n'.length);
  });
  const done = await merge(s, await plan(s.mainId, s.verId));
  expect(await textOf(s.main['body.tex'])).toBe('Alpha one.\n\nGamma three.\n');
  expect(done.carried).toMatchObject({ threads: 1, proposals: 0 });
  expect(done.carried!.left).toHaveLength(2);
  expect(done.carried!.left.join('\n')).toContain('Beta two.');
  expect((await onMain(s)).map((x) => x.now)).toEqual(['Gamma three.']);
  expect(await proposalsOnMain(s)).toHaveLength(0);
  // Still on the version, where it can be dealt with.
  expect(await listThreads(t.pool, store, users.owner.id, s.verId)).toHaveLength(2);
});

test('a second merge does not copy a thread or proposal again, and carries new ones once', async () => {
  const s = await setup();
  await comment(s, 'Alpha one.', 'First.');
  await proposal(s, 'Gamma three.', 'Gamma 3.');
  await touch(s, 'a\n');
  const first = await merge(s, await plan(s.mainId, s.verId));
  expect(first.carried).toMatchObject({ threads: 1, proposals: 1 });
  // Again, with the same ones still open on the version, and one more.
  await comment(s, 'Beta two.', 'Second.');
  await touch(s, 'b\n');
  const second = await merge(s, await plan(s.mainId, s.verId));
  expect(second.carried).toMatchObject({ threads: 1, proposals: 0, left: [] });
  expect((await onMain(s)).map((x) => x.now).sort()).toEqual(['Alpha one.', 'Beta two.']);
  expect(await proposalsOnMain(s)).toHaveLength(1);
  // And a third that carries nothing new.
  await touch(s, 'c\n');
  expect((await merge(s, await plan(s.mainId, s.verId))).carried).toMatchObject({
    threads: 0,
    proposals: 0,
  });
  expect(await onMain(s)).toHaveLength(2);
  // Main brought up to date into the version does not hand the copies back as new threads.
  await editFile(t.pool, store, s.main['intro.tex'], users.owner.id, (y) => y.insert(0, 'm\n'));
  const up = await applyMerge(
    t.pool,
    store,
    users.owner.id,
    s.verId,
    s.mainId,
    ref(await plan(s.verId, s.mainId)),
    {},
    {},
    true,
  );
  expect(up.carried).toMatchObject({ threads: 0, proposals: 0 });
  expect(await listThreads(t.pool, store, users.owner.id, s.verId)).toHaveLength(2);
});

test('resolved threads and decided proposals are never moved', async () => {
  const s = await setup();
  const done = await comment(s, 'Alpha one.', 'Settled.');
  await setThreadStatus(t.pool, users.owner.id, s.verId, done, 'resolved');
  await comment(s, 'Beta two.', 'Open.');
  const a = await proposal(s, 'Gamma three.', 'Gamma 3.');
  await closeProposal(t.pool, users.reviewer.id, s.verId, a, 'dismissed');
  const b = await proposal(s, 'Alpha one.', 'Alpha 1.');
  await acceptProposal(t.pool, store, users.owner.id, s.verId, b);
  await touch(s, 'a\n');
  const out = await merge(s, await plan(s.mainId, s.verId));
  expect(out.carried).toMatchObject({ threads: 1, proposals: 0, left: [] });
  expect((await onMain(s)).map((x) => [x.now, x.status])).toEqual([['Beta two.', 'open']]);
  expect(await proposalsOnMain(s)).toHaveLength(0);
});

test('without the choice nothing is carried', async () => {
  const s = await setup();
  await comment(s, 'Alpha one.', 'Hm.');
  await touch(s, 'a\n');
  const out = await merge(s, await plan(s.mainId, s.verId), false);
  expect(out.carried).toBeUndefined();
  expect(await onMain(s)).toHaveLength(0);
  expect(await textOf(s.main['intro.tex'])).toBe(`${INTRO}a\n`);
});

test('carried threads keep their authors, and carrying gives no one access to anything', async () => {
  const s = await setup();
  // Someone who is on the version only, and comments there.
  await t.pool.query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'reviewer')",
    [s.verId, users.outsider.id],
  );
  const th = await comment(s, 'Alpha one.', 'From a guest.', users.outsider);
  await reply(t.pool, users.editor.id, s.verId, th, { body: 'Thanks.' });
  await proposal(s, 'Beta two.', 'Beta 2.', users.outsider);
  await touch(s, 'a\n');
  const members = async (p: string) =>
    (
      await t.pool.query(
        'select user_id, role from project_members where project_id = $1 order by user_id',
        [p],
      )
    ).rows;
  const before = await members(s.mainId);
  // A viewer, a reviewer and a stranger cannot make the merge, so cannot carry anything.
  const pl = await plan(s.mainId, s.verId);
  for (const who of ['viewer', 'reviewer', 'outsider'] as const)
    expect(await code(merge(s, pl, true, users[who]))).not.toBe('ok');
  expect(await onMain(s)).toHaveLength(0);
  const out = await merge(s, pl, true, users.editor);
  expect(out.carried).toMatchObject({ threads: 1, proposals: 1 });
  // Authors are the people who wrote, not the person who merged.
  const rows = (
    await t.pool.query(
      `select t.created_by, array_agg(c.author order by c.created_at) as authors
       from threads t join thread_comments c on c.thread_id = t.id
       where t.project_id = $1 group by t.id`,
      [s.mainId],
    )
  ).rows;
  expect(rows).toEqual([
    { created_by: users.outsider.id, authors: [users.outsider.id, users.editor.id] },
  ]);
  expect(
    (await t.pool.query('select author from proposals where project_id = $1', [s.mainId])).rows,
  ).toEqual([{ author: users.outsider.id }]);
  // Nobody was added to either paper, and the guest still cannot read main.
  expect(await members(s.mainId)).toEqual(before);
  expect(await code(listThreads(t.pool, store, users.outsider.id, s.mainId))).toBe('not_found');
  expect(await code(listProposals(t.pool, store, users.outsider.id, s.mainId))).toBe('not_found');
  // A viewer of main reads them, as any thread of main. No mention was copied.
  expect((await onMain(s, users.viewer))[0].comments.every((c) => c.mentions.length === 0)).toBe(
    true,
  );
});
