// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, onTestFinished, test } from 'vitest';
import * as Y from 'yjs';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import type { Db } from './db.ts';
import { importZip, listFiles } from './import.ts';
import { acceptInvitation, invite } from './projects.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { mayWrite } from './limits.ts';
import { propose } from './proposals.ts';
import { submissionChecks } from './submit.ts';
import {
  deleteComment,
  editComment,
  listThreads,
  MENTION_EMAILS_PER_HOUR,
  reattachThread,
  reply,
  setThreadStatus,
  startThread,
} from './threads.ts';

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
  // Each paper invites two people; many papers in this file would reach the hourly limit.
  await t.pool.query("update invitations set created_at = now() - interval '2 hours'");
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

/** A paper with a thread on "below 40 ms", the words also standing in a second sentence. */
async function twice() {
  const p = await paper();
  await change(p.file, 'Nothing else', 'It is below 40 ms. Nothing else');
  const { id } = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Check this number.',
  });
  return { p, id };
}
const SENTENCE = 'Latency stays below 40 ms for most edits.\n';

test('after an undo, the person who undid tells where the words stand, and the thread attaches', async () => {
  const { p, id } = await twice();
  const attach = (who: keyof typeof users, places?: { from: Uint8Array; to: Uint8Array }) =>
    reattachThread(t.pool, store, users[who].id, p.id, id, places);
  await change(p.file, SENTENCE, '');
  expect((await threads(p))[0].state).toBe('detached');
  // Undo writes the sentence again as new characters, where it stood.
  await editFile(t.pool, store, p.file, users.owner.id, (text) => {
    const at = text.toString().indexOf('\\begin{document}\n') + '\\begin{document}\n'.length;
    text.insert(at, SENTENCE);
  });
  expect((await threads(p))[0].state).toBe('detached');
  // Without places, the words are in the file twice.
  expect(await code(attach('reviewer'))).toBe('conflict');
  const stand = await ends(p.file, 'below 40 ms');
  expect(await code(attach('viewer', stand))).toBe('permission_denied');
  expect(await code(attach('outsider', stand))).toBe('not_found');
  // A place the saved text does not know yet.
  const unsent = new Y.Doc();
  unsent.getText(TEXT).insert(0, 'typed a moment ago');
  const unknown = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(unsent.getText(TEXT), 3, 0),
  );
  expect(await code(attach('reviewer', { from: unknown, to: stand.to }))).toBe('conflict');
  expect((await threads(p))[0].state).toBe('detached');
  await attach('reviewer', stand);
  expect((await threads(p))[0]).toMatchObject({
    state: 'attached',
    now: 'below 40 ms',
    before: '\\documentclass{article}\n\\begin{document}\nLatency stays ',
    comments: [{ body: 'Check this number.' }],
  });
});

test('places on other words than the thread was about are refused', async () => {
  const { p, id } = await twice();
  await change(p.file, SENTENCE, '');
  const other = await ends(p.file, 'Nothing else');
  expect(await code(reattachThread(t.pool, store, users.reviewer.id, p.id, id, other))).toBe(
    'conflict',
  );
  expect((await threads(p))[0].state).toBe('detached');
});

test('places on a thread that is still attached are refused', async () => {
  const { p, id } = await twice();
  const stand = await ends(p.file, 'below 40 ms');
  expect(await code(reattachThread(t.pool, store, users.reviewer.id, p.id, id, stand))).toBe(
    'invalid_input',
  );
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

test('mention emails are limited to sixty an hour, and a comment past that is saved all the same', async () => {
  // This test writes more comments in ten minutes than one person may by default (the limit has
  // its own test below), so it is given room: it is about the emails, not the comments.
  process.env.COMMENTS_PER_USER = '1000';
  onTestFinished(() => void delete process.env.COMMENTS_PER_USER);
  // The count is of one person's comments in the last hour: the tests above are theirs too.
  await t.pool.query('delete from thread_comments');
  const p = await paper();
  const first = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Start.',
    mentions: [users.owner.id],
  });
  expect(first.mentioned).toEqual(['owner@example.org']);
  expect(first.limited).toBeUndefined();
  // 59 more replies, each addressed to the owner: sixty emails in all.
  for (let i = 1; i < MENTION_EMAILS_PER_HOUR; i++) {
    const r = await reply(t.pool, users.reviewer.id, p.id, first.id, {
      body: `Reply ${i}.`,
      mentions: [users.owner.id],
    });
    expect(r.mentioned, `email ${i + 1}`).toEqual(['owner@example.org']);
  }
  // The 61st is saved, and not emailed.
  const over = await reply(t.pool, users.reviewer.id, p.id, first.id, {
    body: 'The sixty-first.',
    mentions: [users.owner.id],
  });
  expect(over).toEqual({ fileId: p.file, mentioned: [], limited: true });
  const [thread] = await threads(p);
  expect(thread.comments).toHaveLength(MENTION_EMAILS_PER_HOUR + 1);
  expect(thread.comments.at(-1)).toMatchObject({
    body: 'The sixty-first.',
    mentions: ['owner@example.org'],
  });
  // Comments that mention nobody are not held back, and another person has a count of their own.
  expect(await reply(t.pool, users.reviewer.id, p.id, first.id, { body: 'No one.' })).toEqual({
    fileId: p.file,
    mentioned: [],
  });
  expect(
    (
      await reply(t.pool, users.owner.id, p.id, first.id, {
        body: 'Thanks.',
        mentions: [users.reviewer.id],
      })
    ).mentioned,
  ).toEqual(['reviewer@example.org']);
  // An hour later the count has run down: comments from an hour ago do not count.
  await t.pool.query("update thread_comments set created_at = now() - interval '61 minutes'");
  expect(
    (
      await reply(t.pool, users.reviewer.id, p.id, first.id, {
        body: 'Later.',
        mentions: [users.owner.id],
      })
    ).mentioned,
  ).toEqual(['owner@example.org']);
});

test('part of a comment past the limit is emailed: only as many as the hour allows', async () => {
  // The count is of one person's comments in the last hour: the tests above are theirs too.
  await t.pool.query('delete from thread_comments');
  const p = await paper();
  const first = await startThread(
    t.pool,
    store,
    users.reviewer.id,
    p.id,
    p.file,
    { ...(await ends(p.file, 'below 40 ms')), body: 'One.', mentions: [users.owner.id] },
    2,
  );
  expect(first.mentioned).toHaveLength(1);
  const two = await reply(
    t.pool,
    users.reviewer.id,
    p.id,
    first.id,
    { body: 'Two.', mentions: [users.owner.id, users.viewer.id] },
    2,
  );
  expect(two.mentioned).toHaveLength(1);
  expect(two.limited).toBe(true);
});

test('a comment is changed by its author and deleted by its author or the owner', async () => {
  const p = await paper();
  const other = await paper();
  const first = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Median or tail?',
  });
  await reply(t.pool, users.owner.id, p.id, first.id, { body: 'Tail, then.' });
  const [started] = await threads(p);
  const [mine, theirs] = started.comments;

  // The author changes their own: trimmed, marked as changed, the same words are not a change.
  await editComment(t.pool, users.reviewer.id, p.id, first.id, mine.id, { body: '  Median?  ' });
  let [thread] = await threads(p);
  expect(thread.comments[0]).toMatchObject({ body: 'Median?', author: 'reviewer@example.org' });
  expect(thread.comments[0].editedAt).toEqual(expect.any(String));
  expect(thread.comments[1].editedAt).toBeNull();
  const when = thread.comments[0].editedAt;
  await editComment(t.pool, users.reviewer.id, p.id, first.id, mine.id, { body: 'Median?' });
  expect((await threads(p))[0].comments[0].editedAt).toBe(when);

  // What the reader may do is told to the page, and decided again by the server.
  const seen = async (who: keyof typeof users) =>
    (await listThreads(t.pool, store, users[who].id, p.id))[0].comments.map((c) => [
      c.yours,
      c.removable,
    ]);
  expect(await seen('reviewer')).toEqual([
    [true, true],
    [false, false],
  ]);
  expect(await seen('owner')).toEqual([
    [false, true],
    [true, true],
  ]);
  expect(await seen('viewer')).toEqual([
    [false, false],
    [false, false],
  ]);

  // Empty and too long words; and who may not.
  for (const bad of ['  ', '', 5, 'x'.repeat(5001)])
    expect(
      await code(editComment(t.pool, users.reviewer.id, p.id, first.id, mine.id, { body: bad })),
    ).toBe('invalid_input');
  const edit = (who: keyof typeof users, project: string, thread: string, comment: string) =>
    code(editComment(t.pool, users[who].id, project, thread, comment, { body: 'Changed.' }));
  expect(await edit('owner', p.id, first.id, mine.id)).toBe('permission_denied');
  expect(await edit('viewer', p.id, first.id, mine.id)).toBe('permission_denied');
  expect(await edit('outsider', p.id, first.id, mine.id)).toBe('not_found');
  expect(await edit('reviewer', other.id, first.id, mine.id)).toBe('not_found');
  expect(await edit('reviewer', p.id, '00000000-0000-4000-8000-000000000000', mine.id)).toBe(
    'not_found',
  );
  expect(await edit('reviewer', p.id, first.id, '00000000-0000-4000-8000-000000000000')).toBe(
    'not_found',
  );
  const second = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else')),
    body: 'Which else?',
  });
  expect(await edit('reviewer', p.id, second.id, mine.id)).toBe('not_found');
  expect((await threads(p))[0].comments[0].body).toBe('Median?');

  // Deleting: not by another reviewer-level person, the viewer or an outsider; by the owner.
  const del = (who: keyof typeof users, project: string, thread: string, comment: string) =>
    code(deleteComment(t.pool, users[who].id, project, thread, comment));
  expect(await del('reviewer', p.id, first.id, theirs.id)).toBe('permission_denied');
  expect(await del('viewer', p.id, first.id, theirs.id)).toBe('permission_denied');
  expect(await del('outsider', p.id, first.id, theirs.id)).toBe('not_found');
  expect(await del('owner', other.id, first.id, theirs.id)).toBe('not_found');
  expect(await del('owner', p.id, second.id, theirs.id)).toBe('not_found');
  expect((await threads(p))[0].comments).toHaveLength(2);
  expect(await del('owner', p.id, first.id, theirs.id)).toBe('ok');
  [thread] = await threads(p);
  expect(thread.comments.map((c) => c.body)).toEqual(['Median?']);
  // The row is kept, with nothing left of its words.
  const row = (
    await t.pool.query('select body, deleted_at from thread_comments where id = $1', [theirs.id])
  ).rows[0];
  expect(row.body).toBe('');
  expect(row.deleted_at).toBeInstanceOf(Date);
  // A deleted comment can be neither changed nor deleted again.
  expect(await edit('owner', p.id, first.id, theirs.id)).toBe('not_found');
  expect(await del('owner', p.id, first.id, theirs.id)).toBe('not_found');

  // The author deletes their own, and a thread with no comment left is gone, from the paper
  // and from its file.
  expect(await del('reviewer', p.id, first.id, mine.id)).toBe('ok');
  expect((await threads(p)).map((x) => x.id)).toEqual([second.id]);
  expect((await listThreads(t.pool, store, users.owner.id, p.id, p.file)).map((x) => x.id)).toEqual(
    [second.id],
  );
});

test('a comment deleted between the check and the save is not written to', async () => {
  const p = await paper();
  const made = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Median or tail?',
  });
  const [{ comments }] = await threads(p);
  const [mine] = comments;
  // A person who deletes it just after the author's check, before the update.
  const racing = {
    query: async (sql: string, params?: unknown[]) => {
      if (/^\s*update thread_comments set body = \$2/.test(sql))
        await deleteComment(t.pool, users.reviewer.id, p.id, made.id, mine.id);
      return t.pool.query(sql, params as never);
    },
  } as unknown as Db;
  expect(
    await code(
      editComment(racing, users.reviewer.id, p.id, made.id, mine.id, { body: 'Changed.' }),
    ),
  ).toBe('not_found');
  const row = (
    await t.pool.query('select body, deleted_at from thread_comments where id = $1', [mine.id])
  ).rows[0];
  expect(row.body).toBe('');
  expect(row.deleted_at).toBeInstanceOf(Date);
});

test('a paper whose only thread has no comment left has no unfinished review', async () => {
  const p = await paper();
  const made = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Oops, wrong paper.',
  });
  const warned = async () =>
    (await submissionChecks(t.pool, store, users.owner.id, p.id)).findings.filter(
      (f) => f.kind === 'review',
    );
  expect(await warned()).toEqual([
    { level: 'warning', kind: 'review', message: '1 thread is still open.' },
  ]);
  const [{ comments }] = await threads(p);
  await deleteComment(t.pool, users.reviewer.id, p.id, made.id, comments[0].id);
  expect(await warned()).toEqual([]);
});

test('a thread is not resolved over a comment its resolver was not shown', async () => {
  const p = await paper();
  const made = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Is that measured?',
  });
  const mark = async () => (await threads(p))[0].mark;
  const resolve = (seen?: unknown, who = users.owner, paper = p.id, thread = made.id) =>
    setThreadStatus(t.pool, who.id, paper, thread, 'resolved', seen);
  const m0 = await mark();
  expect(m0).toMatch(/^[0-9a-f]{32}$/);

  // Someone writes in the thread after the resolver's page was drawn.
  await reply(t.pool, users.reviewer.id, p.id, made.id, { body: 'Wait: the number is wrong.' });
  expect(await code(resolve(m0))).toBe('conflict');
  const row = () =>
    t.pool
      .query('select status, resolved_at from threads where id = $1', [made.id])
      .then((r) => r.rows[0]);
  expect(await row()).toMatchObject({ status: 'open', resolved_at: null });
  const m1 = await mark();
  expect(m1).not.toBe(m0);

  // A change to a comment, and the deletion of one, each move the mark.
  const [{ comments }] = await threads(p);
  await editComment(t.pool, users.reviewer.id, p.id, made.id, comments[1].id, {
    body: 'Wait: the number is wrong, twice.',
  });
  const m2 = await mark();
  expect(m2).not.toBe(m1);
  await deleteComment(t.pool, users.reviewer.id, p.id, made.id, comments[1].id);
  const m3 = await mark();
  expect(m3).not.toBe(m2);
  expect(await code(resolve(m2))).toBe('conflict');

  // Bad marks are refused as input; a valid-looking mark on another paper or thread is not found.
  expect(await code(resolve('x'))).toBe('invalid_input');
  expect(await code(resolve(5))).toBe('invalid_input');
  const other = await paper();
  expect(await code(resolve(m3, users.owner, other.id))).toBe('not_found');
  expect(await code(resolve(m3, users.owner, p.id, '00000000-0000-4000-8000-000000000000'))).toBe(
    'not_found',
  );
  expect((await row()).status).toBe('open');

  // The current mark resolves; opening again is never guarded; no mark behaves as it did.
  expect(await code(resolve(m3))).toBe('ok');
  expect((await row()).status).toBe('resolved');
  expect(await code(setThreadStatus(t.pool, users.owner.id, p.id, made.id, 'open', m0))).toBe('ok');
  expect((await row()).status).toBe('open');
  expect(await code(resolve())).toBe('ok');
  expect((await row()).status).toBe('resolved');
});

test('a reply to a thread with no comment left is refused', async () => {
  const p = await paper();
  const made = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Oops, wrong paper.',
  });
  const [{ comments }] = await threads(p);
  await deleteComment(t.pool, users.reviewer.id, p.id, made.id, comments[0].id);
  expect(
    await code(reply(t.pool, users.owner.id, p.id, made.id, { body: 'An answer to nothing.' })),
  ).toBe('conflict');
  const { rows } = await t.pool.query(
    'select count(*)::int as n from thread_comments where thread_id = $1',
    [made.id],
  );
  expect(rows[0].n).toBe(1);
  expect(await threads(p)).toEqual([]);
});

test('deleting comments does not reset the limit on mention emails', async () => {
  await t.pool.query('delete from thread_comments');
  const p = await paper();
  const first = await startThread(
    t.pool,
    store,
    users.reviewer.id,
    p.id,
    p.file,
    { ...(await ends(p.file, 'below 40 ms')), body: 'One.', mentions: [users.owner.id] },
    2,
  );
  const second = await reply(
    t.pool,
    users.reviewer.id,
    p.id,
    first.id,
    { body: 'Two.', mentions: [users.owner.id] },
    2,
  );
  expect(second.mentioned).toHaveLength(1);
  // Delete both, then a third is still past the limit of two.
  for (const c of (await threads(p))[0].comments)
    await deleteComment(t.pool, users.reviewer.id, p.id, first.id, c.id);
  const again = await startThread(
    t.pool,
    store,
    users.reviewer.id,
    p.id,
    p.file,
    { ...(await ends(p.file, 'below 40 ms')), body: 'Three.', mentions: [users.owner.id] },
    2,
  );
  expect(again).toMatchObject({ mentioned: [], limited: true });
});

test('one person cannot write more than sixty comments in ten minutes on a paper, nor a paper take more than its day', async () => {
  // The owner's invitations in the tests above would count against this one's papers.
  await t.pool.query("update invitations set created_at = now() - interval '2 hours'");
  const p = await paper();
  const first = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Start.',
  });
  // 59 more replies make sixty, with the first.
  for (let i = 1; i < 60; i++)
    await reply(t.pool, users.reviewer.id, p.id, first.id, { body: `Reply ${i}.` });
  const refused = await reply(t.pool, users.reviewer.id, p.id, first.id, {
    body: 'The sixty-first.',
  }).catch((e) => e);
  expect(refused.code).toBe('conflict');
  expect(refused.message).toMatch(/sixty|60 comments/);
  // A new thread, a proposal, and a reply to a different thread are all the same flood.
  expect(
    await code(
      startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
        ...(await ends(p.file, 'below 40 ms')),
        body: 'Again.',
      }),
    ),
  ).toBe('conflict');
  expect(
    await code(
      propose(t.pool, store, users.reviewer.id, p.id, p.file, {
        ...(await ends(p.file, 'below 40 ms')),
        replacement: 'under 40 ms',
      }),
    ),
  ).toBe('conflict');
  // Deleting comments does not buy room: the rows stay.
  const [thread] = await threads(p);
  await deleteComment(t.pool, users.reviewer.id, p.id, thread.id, thread.comments[0].id);
  expect(await code(reply(t.pool, users.reviewer.id, p.id, first.id, { body: 'x' }))).toBe(
    'conflict',
  );
  // Another person on the same paper is not held back by it, and the viewer is not a writer.
  expect(await code(reply(t.pool, users.owner.id, p.id, first.id, { body: 'Fine.' }))).toBe('ok');
  // Ten minutes later the count has run down.
  await t.pool.query("update thread_comments set created_at = now() - interval '11 minutes'");
  expect(await code(reply(t.pool, users.reviewer.id, p.id, first.id, { body: 'Later.' }))).toBe(
    'ok',
  );
  // The paper's own cap over a day, from everyone.
  expect(await code(mayWrite(t.pool, users.owner.id, p.id, { perPaper: 5 }))).toBe('conflict');
  expect(await code(mayWrite(t.pool, users.owner.id, p.id, { perPaper: 5000 }))).toBe('ok');
  // Another paper is its own.
  const other = await paper();
  expect(
    await code(
      startThread(t.pool, store, users.reviewer.id, other.id, other.file, {
        ...(await ends(other.file, 'below 40 ms')),
        body: 'Elsewhere.',
      }),
    ),
  ).toBe('ok');
});
