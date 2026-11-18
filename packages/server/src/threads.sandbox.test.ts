// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { importZip, listFiles } from './import.ts';
import { acceptInvitation, invite } from './projects.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { listThreads, reattachThread, reply, setThreadStatus, startThread } from './threads.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
const users = {} as Record<
  'owner' | 'reviewer' | 'viewer' | 'outsider',
  { id: string; email: string }
>;

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'reviewer', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
});
afterAll(() => t.close());

const MAIN =
  '\\documentclass{article}\n\\begin{document}\nLatency stays below 40 ms for most edits.\nNothing else is claimed.\n\\end{document}\n';
async function paper() {
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Threads');
  for (const who of ['reviewer', 'viewer'] as const) {
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, who);
    await acceptInvitation(t.pool, users[who].id, token);
  }
  const [{ id: file }] = await listFiles(t.pool, users.owner.id, project.id);
  return { id: project.id, file };
}
/** The two ends of a stretch of the saved text, as an editor would send them. */
async function ends(file: string, words: string) {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  const text = doc.getText(TEXT);
  const at = text.toString().indexOf(words);
  if (at < 0) throw new Error(`"${words}" is not in the file`);
  return {
    from: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, 0)),
    to: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, at + words.length, -1),
    ),
  };
}
const change = (file: string, from: string, to: string) =>
  editFile(t.pool, store, file, users.owner.id, (text) => {
    const at = text.toString().indexOf(from);
    if (at < 0) throw new Error(`"${from}" is not in the file`);
    text.delete(at, from.length);
    text.insert(at, to);
  });
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );
const threads = (p: { id: string }) => listThreads(t.pool, store, users.viewer.id, p.id);

test('a thread is started on a stretch of text, answered, resolved and opened again', async () => {
  const p = await paper();
  const started = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: '  Is that the median or the tail?  ',
    // Addressed to the owner, and to themselves, who need not be told.
    mentions: [users.owner.id, users.reviewer.id],
  });
  expect(started.mentioned).toEqual(['owner@example.org']);
  expect(await threads(p)).toMatchObject([
    {
      id: started.id,
      fileId: p.file,
      path: 'main.tex',
      state: 'attached',
      excerpt: 'below 40 ms',
      before: '\\documentclass{article}\n\\begin{document}\nLatency stays ',
      after: ' for most edits.\nNothing else is claimed.\n\\end{document}\n',
      now: 'below 40 ms',
      status: 'open',
      startedBy: 'reviewer@example.org',
      comments: [
        {
          author: 'reviewer@example.org',
          body: 'Is that the median or the tail?',
          mentions: ['owner@example.org', 'reviewer@example.org'],
        },
      ],
    },
  ]);

  const answered = await reply(t.pool, users.owner.id, p.id, started.id, {
    body: 'The 95th percentile.',
    mentions: [users.reviewer.id],
  });
  expect(answered).toEqual({ fileId: p.file, mentioned: ['reviewer@example.org'] });
  await setThreadStatus(t.pool, users.owner.id, p.id, started.id, 'resolved');
  const [done] = await threads(p);
  expect(done.status).toBe('resolved');
  expect(done.comments.map((c) => c.body)).toEqual([
    'Is that the median or the tail?',
    'The 95th percentile.',
  ]);
  // A reviewer may open it again.
  await setThreadStatus(t.pool, users.reviewer.id, p.id, started.id, 'open');
  expect((await threads(p))[0].status).toBe('open');
  // Only this file's threads when a file is named.
  expect(await listThreads(t.pool, store, users.viewer.id, p.id, p.file)).toHaveLength(1);
});

test('a thread follows its text, says when it has changed, and is kept when it is deleted', async () => {
  const p = await paper();
  await startThread(t.pool, store, users.owner.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Check this number.',
  });
  const state = async () => {
    const [th] = await threads(p);
    return [th.state, th.now];
  };

  // Typing before it, after it, and right up against both ends leaves it as it was.
  await change(p.file, 'Latency stays', 'In our runs, latency stays well');
  await change(p.file, ' for most', ', we find, for most');
  await change(p.file, 'well ', 'well and truly ');
  expect(await state()).toEqual(['attached', 'below 40 ms']);
  // Typing inside it: the thread is about the text as it now reads, and says it has changed.
  await change(p.file, '40', '45');
  expect(await state()).toEqual(['changed', 'below 45 ms']);
  // Put back exactly: as it was.
  await change(p.file, '45', '40');
  expect(await state()).toEqual(['attached', 'below 40 ms']);

  // The sentence is cut. The thread is still there, with what it was about and what stood round it.
  await change(
    p.file,
    'In our runs, latency stays well and truly below 40 ms, we find, for most edits.\n',
    '',
  );
  const [gone] = await threads(p);
  expect(gone).toMatchObject({
    state: 'detached',
    now: '',
    excerpt: 'below 40 ms',
    before: '\\documentclass{article}\n\\begin{document}\nLatency stays ',
    status: 'open',
  });
  expect(gone.comments).toHaveLength(1);
  // It can still be answered and resolved.
  await reply(t.pool, users.reviewer.id, p.id, gone.id, { body: 'Cut, so no longer a question.' });
  await setThreadStatus(t.pool, users.reviewer.id, p.id, gone.id, 'resolved');
  expect((await threads(p))[0]).toMatchObject({ state: 'detached', status: 'resolved' });
});

test('a detached thread is attached again to the same words, when there is no doubt which', async () => {
  const p = await paper();
  const { id } = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Check this number.',
  });
  const attach = (who: keyof typeof users = 'reviewer') =>
    reattachThread(t.pool, store, users[who].id, p.id, id);
  // Nothing to do while it is where it was.
  expect(await code(attach())).toBe('invalid_input');
  await change(p.file, 'Latency stays below 40 ms for most edits.\n', '');
  expect((await threads(p))[0].state).toBe('detached');
  // The words are nowhere.
  expect(await code(attach())).toBe('conflict');
  // They are back twice: which is meant?
  await change(p.file, 'Nothing else', 'It is below 40 ms. Often well below 40 ms. Nothing else');
  expect(await code(attach())).toBe('conflict');
  expect((await threads(p))[0].state).toBe('detached');
  // Once: that is where the thread now belongs, and it follows the text from there.
  await change(p.file, ' Often well below 40 ms.', '');
  expect(await code(attach('viewer'))).toBe('permission_denied');
  expect(await code(attach('outsider'))).toBe('not_found');
  await attach();
  expect((await threads(p))[0]).toMatchObject({
    state: 'attached',
    now: 'below 40 ms',
    before: '\\documentclass{article}\n\\begin{document}\nIt is ',
    comments: [{ body: 'Check this number.' }],
  });
  await change(p.file, 'It is', 'We find it is');
  expect((await threads(p))[0]).toMatchObject({ state: 'attached', now: 'below 40 ms' });
});

test('threads keep to their paper and to the people who may comment', async () => {
  const p = await paper();
  const other = await paper();
  const at = await ends(p.file, 'below 40 ms');
  const start = (who: keyof typeof users, input: object = {}, project = p.id, file = p.file) =>
    startThread(t.pool, store, users[who].id, project, file, { ...at, body: 'Hm.', ...input });
  expect(await code(start('viewer'))).toBe('permission_denied');
  expect(await code(start('outsider'))).toBe('not_found');
  expect(await code(start('owner', { body: '   ' }))).toBe('invalid_input');
  expect(await code(start('owner', { body: 'x'.repeat(5001) }))).toBe('invalid_input');
  // An empty stretch, a stretch turned round, and places that are not places.
  expect(await code(start('owner', { to: at.from }))).toBe('invalid_input');
  expect(await code(start('owner', { from: at.to, to: at.from }))).toBe('invalid_input');
  expect(await code(start('owner', { from: 'nowhere' }))).toBe('invalid_input');
  expect(await code(start('owner', { from: new Uint8Array(101) }))).toBe('invalid_input');
  // A place in text the server has not been sent yet.
  const unsent = new Y.Doc();
  unsent.getText(TEXT).insert(0, 'typed a moment ago');
  const place = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(unsent.getText(TEXT), 3, 0),
  );
  expect(await code(start('owner', { from: place }))).toBe('conflict');
  // Addressed to someone who is not on the paper, or to nobody that exists.
  expect(await code(start('owner', { mentions: [users.outsider.id] }))).toBe('invalid_input');
  expect(await code(start('owner', { mentions: 'everyone' }))).toBe('invalid_input');
  // A file of another paper, through this one.
  expect(await code(start('owner', {}, p.id, other.file))).toBe('not_found');

  const { id } = await start('reviewer');
  const answer = (who: keyof typeof users, project = p.id) =>
    reply(t.pool, users[who].id, project, id, { body: 'Yes.' });
  expect(await code(answer('viewer'))).toBe('permission_denied');
  expect(await code(answer('outsider'))).toBe('not_found');
  expect(await code(answer('owner', other.id))).toBe('not_found');
  expect(await code(setThreadStatus(t.pool, users.viewer.id, p.id, id, 'resolved'))).toBe(
    'permission_denied',
  );
  expect(await code(setThreadStatus(t.pool, users.owner.id, other.id, id, 'resolved'))).toBe(
    'not_found',
  );
  expect(await code(setThreadStatus(t.pool, users.owner.id, p.id, id, 'closed'))).toBe(
    'invalid_input',
  );
  expect(await code(listThreads(t.pool, store, users.outsider.id, p.id))).toBe('not_found');
  expect(await listThreads(t.pool, store, users.owner.id, other.id)).toEqual([]);
});
