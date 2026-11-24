// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { WEB_EDIT_SMALL_FLOOR } from './limits.ts';
import { acceptInvitation, invite } from './projects.ts';
import {
  acceptProposal,
  closeProposal,
  listProposals,
  propose,
  reattachProposal,
  reviseProposal,
  undoAccept,
} from './proposals.ts';
import { submissionChecks } from './submit.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
const users = {} as Record<
  'owner' | 'editor' | 'reviewer' | 'viewer' | 'outsider',
  { id: string; email: string }
>;

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'editor', 'reviewer', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
});
afterAll(() => t.close());

const LINE = 'Latency stays below 40 ms for most edits.';
const MAIN = `\\documentclass{article}\n\\begin{document}\n${LINE}\nNothing else is claimed.\n\\end{document}\n`;
async function paper() {
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Proposals');
  for (const who of ['editor', 'reviewer', 'viewer'] as const) {
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, who, 1000);
    await acceptInvitation(t.pool, users[who].id, token);
  }
  const [{ id: file }] = await listFiles(t.pool, users.owner.id, project.id);
  return { id: project.id, file };
}
/** The two ends of a stretch of the saved text, as an editor would send them. */
async function ends(file: string, words: string, length = words.length) {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  const text = doc.getText(TEXT);
  const at = text.toString().indexOf(words);
  if (at < 0) throw new Error(`"${words}" is not in the file`);
  return {
    from: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, 0)),
    to: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at + length, -1)),
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
/** The file as a download has it. */
const saved = async (p: { id: string }) =>
  Buffer.from(
    (await readZip(await exportZip(t.pool, store, users.owner.id, p.id))).entries[0].bytes,
  ).toString();
const proposals = (p: { id: string }, who: keyof typeof users = 'viewer') =>
  listProposals(t.pool, store, users[who].id, p.id);

test('a reviewer proposes, nothing changes until an editor accepts, and an accept can be undone', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
    reason: '  Shorter.  ',
  });
  // Proposed is not written.
  expect(await saved(p)).toBe(MAIN);
  expect(await proposals(p, 'reviewer')).toMatchObject([
    {
      id,
      path: 'main.tex',
      expected: 'below 40 ms',
      replacement: 'under 40 ms',
      reason: 'Shorter.',
      status: 'open',
      stale: false,
      now: 'below 40 ms',
      author: 'reviewer@example.org',
      mine: true,
      decidedBy: null,
    },
  ]);
  expect((await proposals(p))[0].mine).toBe(false);

  await acceptProposal(t.pool, store, users.editor.id, p.id, id);
  expect(await saved(p)).toBe(MAIN.replace('below 40 ms', 'under 40 ms'));
  expect(await proposals(p)).toMatchObject([
    { status: 'accepted', stale: false, now: 'under 40 ms', decidedBy: 'editor@example.org' },
  ]);
  // Asked again, as after a lost answer: still accepted, and applied once.
  await acceptProposal(t.pool, store, users.owner.id, p.id, id);
  expect(await saved(p)).toBe(MAIN.replace('below 40 ms', 'under 40 ms'));

  // Undone: the text is as it was, byte for byte, and the proposal is open again.
  await undoAccept(t.pool, store, users.owner.id, p.id, id);
  expect(await saved(p)).toBe(MAIN);
  expect(await proposals(p)).toMatchObject([
    { status: 'open', stale: false, now: 'below 40 ms', decidedBy: null },
  ]);
  await undoAccept(t.pool, store, users.owner.id, p.id, id);
  expect(await saved(p)).toBe(MAIN);
  // And can be accepted once more.
  await acceptProposal(t.pool, store, users.owner.id, p.id, id);
  expect(await saved(p)).toBe(MAIN.replace('below 40 ms', 'under 40 ms'));
});

test('a proposal follows its text, and is stale once that text says something else', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
  });
  // Edits elsewhere move it and do not make it stale.
  await change(p.file, 'Latency stays', 'In our runs, latency stays');
  expect(await proposals(p)).toMatchObject([{ stale: false, now: 'below 40 ms' }]);
  // An edit inside it does. It is not applied over text its author never saw.
  await change(p.file, '40', '45');
  expect(await proposals(p)).toMatchObject([{ stale: true, now: 'below 45 ms', status: 'open' }]);
  const before = await saved(p);
  expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, id))).toBe('conflict');
  expect(await saved(p)).toBe(before);
  expect((await proposals(p))[0].status).toBe('open');

  // Its author looks again and proposes for the text as it now reads.
  await reviseProposal(t.pool, store, users.reviewer.id, p.id, id, {
    replacement: 'under 45 ms',
    reason: 'Still shorter.',
  });
  expect(await proposals(p)).toMatchObject([
    { stale: false, expected: 'below 45 ms', replacement: 'under 45 ms', reason: 'Still shorter.' },
  ]);
  await acceptProposal(t.pool, store, users.owner.id, p.id, id);
  expect(await saved(p)).toBe(
    MAIN.replace(LINE, 'In our runs, latency stays under 45 ms for most edits.'),
  );

  // Once the accepted words have been changed, the accept can no longer be put back.
  await change(p.file, 'under 45 ms', 'under 45 ms at the median');
  await change(p.file, '45', '46');
  expect(await proposals(p)).toMatchObject([{ status: 'accepted', stale: true }]);
  expect(await code(undoAccept(t.pool, store, users.owner.id, p.id, id))).toBe('conflict');
  expect((await proposals(p))[0].status).toBe('accepted');
});

test('a proposal can add text, take text away, be turned down or withdrawn', async () => {
  const p = await paper();
  // Nothing selected: an insertion at that place.
  const add = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else', 0)),
    replacement: 'We measured three writers. ',
  });
  // Replaced with nothing: a deletion.
  const cut = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, ' for most edits')),
    replacement: '',
  });
  const no = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Latency')),
    replacement: 'Delay',
  });
  const mine = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'claimed')),
    replacement: 'shown',
  });
  await acceptProposal(t.pool, store, users.owner.id, p.id, add);
  await acceptProposal(t.pool, store, users.owner.id, p.id, cut);
  await closeProposal(t.pool, users.editor.id, p.id, no, 'rejected');
  await closeProposal(t.pool, users.reviewer.id, p.id, mine, 'dismissed');
  expect(await saved(p)).toBe(
    MAIN.replace(' for most edits', '').replace('Nothing', 'We measured three writers. Nothing'),
  );
  expect((await proposals(p)).map((x) => [x.status, x.decidedBy])).toEqual([
    ['accepted', 'owner@example.org'],
    ['accepted', 'owner@example.org'],
    ['rejected', 'editor@example.org'],
    ['dismissed', 'reviewer@example.org'],
  ]);
  // The deletion is put back where it was.
  await undoAccept(t.pool, store, users.owner.id, p.id, cut);
  expect(await saved(p)).toBe(MAIN.replace('Nothing', 'We measured three writers. Nothing'));
  // Decided is decided.
  for (const again of [no, mine]) {
    expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, again))).toBe('conflict');
    expect(await code(closeProposal(t.pool, users.owner.id, p.id, again, 'rejected'))).toBe(
      'conflict',
    );
    expect(await code(undoAccept(t.pool, store, users.owner.id, p.id, again))).toBe('conflict');
    expect(
      await code(reviseProposal(t.pool, store, users.owner.id, p.id, again, { replacement: 'x' })),
    ).toBe('conflict');
  }
});

test('proposing is for people who may comment, deciding for people who may edit', async () => {
  const p = await paper();
  const other = await paper();
  const at = await ends(p.file, 'below 40 ms');
  const make = (who: keyof typeof users, input: object = {}, project = p.id, file = p.file) =>
    propose(t.pool, store, users[who].id, project, file, {
      ...at,
      replacement: 'under 40 ms',
      ...input,
    });
  expect(await code(make('viewer'))).toBe('permission_denied');
  expect(await code(make('outsider'))).toBe('not_found');
  expect(await code(make('owner', {}, p.id, other.file))).toBe('not_found');
  // That would change nothing; not text; a carriage return; too long; a stretch turned round.
  expect(await code(make('owner', { replacement: 'below 40 ms' }))).toBe('invalid_input');
  expect(await code(make('owner', { replacement: 7 }))).toBe('invalid_input');
  expect(await code(make('owner', { replacement: 'a\r\nb' }))).toBe('invalid_input');
  expect(await code(make('owner', { replacement: 'x'.repeat(20_001) }))).toBe('invalid_input');
  expect(await code(make('owner', { reason: 'x'.repeat(1001) }))).toBe('invalid_input');
  expect(await code(make('owner', { from: at.to, to: at.from }))).toBe('invalid_input');
  expect(await code(make('owner', { from: 'here' }))).toBe('invalid_input');
  const unsent = new Y.Doc();
  unsent.getText(TEXT).insert(0, 'typed a moment ago');
  const place = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(unsent.getText(TEXT), 3, 0),
  );
  expect(await code(make('owner', { from: place }))).toBe('conflict');

  const id = await make('reviewer');
  const theirs = await make('editor');
  // A reviewer proposes and may change or withdraw their own, and that is all.
  expect(await code(acceptProposal(t.pool, store, users.reviewer.id, p.id, id))).toBe(
    'permission_denied',
  );
  expect(await code(closeProposal(t.pool, users.reviewer.id, p.id, id, 'rejected'))).toBe(
    'permission_denied',
  );
  expect(await code(closeProposal(t.pool, users.reviewer.id, p.id, theirs, 'dismissed'))).toBe(
    'permission_denied',
  );
  expect(
    await code(
      reviseProposal(t.pool, store, users.reviewer.id, p.id, theirs, { replacement: 'x' }),
    ),
  ).toBe('permission_denied');
  expect(await code(undoAccept(t.pool, store, users.reviewer.id, p.id, id))).toBe(
    'permission_denied',
  );
  for (const who of ['viewer', 'outsider'] as const) {
    const refused = who === 'viewer' ? 'permission_denied' : 'not_found';
    expect(await code(acceptProposal(t.pool, store, users[who].id, p.id, id))).toBe(refused);
    expect(await code(closeProposal(t.pool, users[who].id, p.id, id, 'dismissed'))).toBe(refused);
    expect(
      await code(reviseProposal(t.pool, store, users[who].id, p.id, id, { replacement: 'x' })),
    ).toBe(refused);
  }
  // Not through another paper, and not in a way that is neither rejecting nor withdrawing.
  expect(await code(acceptProposal(t.pool, store, users.owner.id, other.id, id))).toBe('not_found');
  expect(await code(closeProposal(t.pool, users.owner.id, p.id, id, 'deleted'))).toBe(
    'invalid_input',
  );
  expect(await code(listProposals(t.pool, store, users.outsider.id, p.id))).toBe('not_found');
  expect(await listProposals(t.pool, store, users.owner.id, other.id)).toEqual([]);
  // After all that, nothing was written and both are still open.
  expect(await saved(p)).toBe(MAIN);
  expect((await proposals(p)).map((x) => x.status)).toEqual(['open', 'open']);
  // An editor may change a reviewer's proposal before accepting it.
  await reviseProposal(t.pool, store, users.editor.id, p.id, id, { replacement: 'under 40~ms' });
  await acceptProposal(t.pool, store, users.editor.id, p.id, id);
  expect(await saved(p)).toBe(MAIN.replace('below 40 ms', 'under 40~ms'));
  // The other proposal was for the same words, which now say something else.
  expect(await proposals(p)).toMatchObject([
    { status: 'accepted' },
    { status: 'open', stale: true },
  ]);
  // The checks before submitting say that review is not finished. It does not stand in the way.
  expect((await submissionChecks(t.pool, store, users.viewer.id, p.id)).findings).toContainEqual({
    level: 'warning',
    kind: 'review',
    message: '1 proposed change has not been decided.',
  });
});

/** The words typed over where they stood: the same text, in new characters nothing is anchored to. */
const retype = (file: string, words: string) => change(file, words, words);

test('a proposal whose words are gone cannot be revived as an insertion', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
  });
  await change(p.file, 'below 40 ms', '');
  expect(await proposals(p)).toMatchObject([{ stale: true, now: '', expected: 'below 40 ms' }]);
  const before = await proposals(p);
  const text = await saved(p);
  expect(
    await code(reviseProposal(t.pool, store, users.reviewer.id, p.id, id, { replacement: 'x' })),
  ).toBe('conflict');
  expect(await proposals(p)).toEqual(before);
  expect(await saved(p)).toBe(text);

  // A proposal made to add text has no words, and can still be changed.
  const add = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else', 0)),
    replacement: 'We measured. ',
  });
  await reviseProposal(t.pool, store, users.reviewer.id, p.id, add, {
    replacement: 'We measured twice. ',
  });
  expect((await proposals(p)).find((x) => x.id === add)).toMatchObject({
    expected: '',
    replacement: 'We measured twice. ',
  });
});

test('a proposal that lost its place finds its words again, when they are there once', async () => {
  const p = await paper();
  const make = async (words: string, replacement: string) =>
    propose(t.pool, store, users.reviewer.id, p.id, p.file, {
      ...(await ends(p.file, words)),
      replacement,
    });
  const open = await make('below 40 ms', 'under 40 ms');
  const taken = await make('Latency', 'Delay');
  const cut = await make(' for most edits', '');
  const done = await make('claimed', 'shown');
  await acceptProposal(t.pool, store, users.owner.id, p.id, done);
  await acceptProposal(t.pool, store, users.owner.id, p.id, cut);
  await closeProposal(t.pool, users.owner.id, p.id, taken, 'rejected');
  const get = async (id: string) => (await proposals(p)).find((x) => x.id === id)!;

  // Still attached: nothing to find again.
  expect(await code(reattachProposal(t.pool, store, users.reviewer.id, p.id, open))).toBe(
    'invalid_input',
  );

  // An open proposal looks for what it expected.
  await retype(p.file, 'below 40 ms');
  expect(await get(open)).toMatchObject({ stale: true, now: '' });
  await reattachProposal(t.pool, store, users.reviewer.id, p.id, open);
  expect(await get(open)).toMatchObject({ stale: false, now: 'below 40 ms' });
  await acceptProposal(t.pool, store, users.owner.id, p.id, open);
  expect(await saved(p)).toContain('under 40 ms');

  // An accepted one looks for what it put there, and can then be undone.
  await retype(p.file, 'shown');
  expect(await code(undoAccept(t.pool, store, users.owner.id, p.id, done))).toBe('conflict');
  await reattachProposal(t.pool, store, users.editor.id, p.id, done);
  expect(await get(done)).toMatchObject({ stale: false, now: 'shown' });
  await undoAccept(t.pool, store, users.owner.id, p.id, done);
  expect(await saved(p)).toContain('is claimed');

  // Decided and rejected: no. Words that are nothing, an accepted deletion: no.
  expect(await code(reattachProposal(t.pool, store, users.owner.id, p.id, taken))).toBe('conflict');
  expect(await code(reattachProposal(t.pool, store, users.owner.id, p.id, cut))).toBe('conflict');

  // Words in the file twice, or not at all: nothing is guessed.
  const twice = await propose(t.pool, store, users.owner.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else')),
    replacement: 'Little else',
  });
  await retype(p.file, 'Nothing else');
  await change(p.file, 'is claimed', 'is claimed. Nothing else');
  const placed = await get(twice);
  expect(await code(reattachProposal(t.pool, store, users.owner.id, p.id, twice))).toBe('conflict');
  expect(await get(twice)).toEqual(placed);
  await change(p.file, 'Nothing else', 'Gone');
  await change(p.file, 'Nothing else', 'Gone');
  expect(await code(reattachProposal(t.pool, store, users.owner.id, p.id, twice))).toBe('conflict');
});

/** A paper with a proposal on "below 40 ms", the words also standing in a second sentence. */
async function twice() {
  const p = await paper();
  await change(p.file, 'Nothing else', 'It is below 40 ms. Nothing else');
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
  });
  return { p, id };
}
const SENTENCE = `${LINE}\n`;
/** Delete the sentence, then write it again as new characters, as an undo does. */
async function deleteAndUndo(file: string) {
  await change(file, SENTENCE, '');
  await editFile(t.pool, store, file, users.owner.id, (text) => {
    const at = text.toString().indexOf('\\begin{document}\n') + '\\begin{document}\n'.length;
    text.insert(at, SENTENCE);
  });
}

test('after an undo, the person who undid tells where the words stand, and the proposal is fresh', async () => {
  const { p, id } = await twice();
  const attach = (who: keyof typeof users, places?: { from: Uint8Array; to: Uint8Array }) =>
    reattachProposal(t.pool, store, users[who].id, p.id, id, places);
  await deleteAndUndo(p.file);
  expect((await proposals(p))[0]).toMatchObject({ stale: true, now: '' });
  expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, id))).toBe('conflict');
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
  expect((await proposals(p))[0].stale).toBe(true);
  await attach('reviewer', stand);
  expect((await proposals(p))[0]).toMatchObject({ stale: false, now: 'below 40 ms' });
  await acceptProposal(t.pool, store, users.owner.id, p.id, id);
  // Applied at the place the undoing tab named: the first sentence, not the second.
  expect(await saved(p)).toBe(
    MAIN.replace('below 40 ms', 'under 40 ms').replace(
      'Nothing else',
      'It is below 40 ms. Nothing else',
    ),
  );
});

test('places on other words than the proposal was about are refused', async () => {
  // The words stand once, so that a search alone would attach it.
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
  });
  await deleteAndUndo(p.file);
  const other = await ends(p.file, 'Nothing else');
  expect(await code(reattachProposal(t.pool, store, users.reviewer.id, p.id, id, other))).toBe(
    'conflict',
  );
  expect((await proposals(p))[0].stale).toBe(true);
});

test('places on a proposal that is not stale are refused', async () => {
  const { p, id } = await twice();
  const stand = await ends(p.file, 'below 40 ms');
  expect(await code(reattachProposal(t.pool, store, users.reviewer.id, p.id, id, stand))).toBe(
    'invalid_input',
  );
});

test('places are not used for an insertion, which has no words to check', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below', 0)),
    replacement: 'well ',
  });
  await deleteAndUndo(p.file);
  expect((await proposals(p))[0]).toMatchObject({ stale: true });
  const stand = await ends(p.file, 'below', 0);
  expect(await code(reattachProposal(t.pool, store, users.reviewer.id, p.id, id, stand))).toBe(
    'conflict',
  );
  expect((await proposals(p))[0].stale).toBe(true);
});

test('a place cannot be found again, and only its author or an editor may try', async () => {
  const p = await paper();
  const add = await propose(t.pool, store, users.owner.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else', 0)),
    replacement: 'We measured. ',
  });
  expect(await code(reattachProposal(t.pool, store, users.owner.id, p.id, add))).toBe('conflict');

  const mine = await propose(t.pool, store, users.owner.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
  });
  await retype(p.file, 'below 40 ms');
  expect(await code(reattachProposal(t.pool, store, users.reviewer.id, p.id, mine))).toBe(
    'permission_denied',
  );
  expect(await code(reattachProposal(t.pool, store, users.viewer.id, p.id, mine))).toBe(
    'permission_denied',
  );
  expect(await code(reattachProposal(t.pool, store, users.outsider.id, p.id, mine))).toBe(
    'not_found',
  );
  expect((await proposals(p))[1]).toMatchObject({ now: '' });
  // The author of one may find it again without being able to decide anything.
  const theirs = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Latency')),
    replacement: 'Delay',
  });
  await retype(p.file, 'Latency');
  await reattachProposal(t.pool, store, users.reviewer.id, p.id, theirs);
  expect((await proposals(p)).find((x) => x.id === theirs)).toMatchObject({ now: 'Latency' });
});

test('a change is judged in its sentence; with no sentence to find, in its words alone', async () => {
  const p = await paper();
  await change(
    p.file,
    'Nothing else is claimed.',
    'Under load the latency is high and the cache is small.',
  );
  const high = async () => ({
    ...(await ends(p.file, 'high')),
    replacement: 'low',
  });
  const flagsOf = async (id: string) => (await proposals(p)).find((x) => x.id === id)!.flags;

  // One word for its opposite says nothing alone, and a direction flag in its sentence.
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, await high());
  expect((await proposals(p)).find((x) => x.id === id)!.expected).toBe('high');
  expect(await flagsOf(id)).toEqual([
    expect.stringMatching(
      /^Which way a comparison goes may have changed: .*up cache.* → .*down cache/,
    ),
  ]);
  // Decided, a proposal shows no flags.
  await closeProposal(t.pool, users.owner.id, p.id, id, 'rejected');
  expect(await flagsOf(id)).toEqual([]);

  // Once its words are not the ones it was made on, it is flagged on its words alone.
  const moved = await propose(t.pool, store, users.reviewer.id, p.id, p.file, await high());
  expect(await flagsOf(moved)).toHaveLength(1);
  await change(p.file, 'high', 'tall');
  expect((await proposals(p)).find((x) => x.id === moved)).toMatchObject({
    stale: true,
    flags: ['Which way a comparison goes may have changed: up → down.'],
  });

  // Where its place is gone altogether, likewise: the numbers it changes are still flagged.
  const gone = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, '40 ms')),
    replacement: '45 ms',
  });
  expect(await flagsOf(gone)).toEqual(['The numbers differ: 40 → 45.']);
  await change(p.file, 'below 40 ms', '');
  expect((await proposals(p)).find((x) => x.id === gone)).toMatchObject({
    stale: true,
    now: '',
    flags: ['The numbers differ: 40 → 45.'],
  });
});

/** A place at an index of the saved text, as an editor with the caret there would send it. */
async function caret(file: string, index: number | 'end') {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  const text = doc.getText(TEXT);
  const i = index === 'end' ? text.length : index;
  return {
    from: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, i, 0)),
    to: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, i, -1)),
  };
}
test('an insertion whose surroundings are retyped is stale and cannot be accepted', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, ' for most edits', 0)),
    replacement: ' not',
  });
  expect(await proposals(p)).toMatchObject([{ stale: false, placeLost: false }]);
  await change(p.file, LINE, 'We found no effect.');
  const after = await saved(p);
  expect(await proposals(p)).toMatchObject([{ stale: true, placeLost: true, now: '' }]);
  expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, id))).toBe('conflict');
  expect(await saved(p)).toBe(after);
  expect((await proposals(p))[0].status).toBe('open');
});

test('an insertion is stale when only the word after it is replaced', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, ' for most edits', 0)),
    replacement: ' not',
  });
  await change(p.file, ' for most', ' per most');
  const after = await saved(p);
  expect(await proposals(p)).toMatchObject([{ stale: true, placeLost: true }]);
  expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, id))).toBe('conflict');
  expect(await saved(p)).toBe(after);
});

test('an accepted deletion whose surroundings are retyped is stale and cannot be undone', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, ' for most edits')),
    replacement: '',
  });
  await acceptProposal(t.pool, store, users.owner.id, p.id, id);
  expect(await proposals(p)).toMatchObject([{ status: 'accepted', stale: false }]);
  await change(p.file, 'Latency stays below 40 ms.', 'We found no effect.');
  const after = await saved(p);
  expect(await proposals(p)).toMatchObject([{ status: 'accepted', stale: true, placeLost: true }]);
  expect(await code(undoAccept(t.pool, store, users.owner.id, p.id, id))).toBe('conflict');
  expect(await saved(p)).toBe(after);
  expect((await proposals(p))[0].status).toBe('accepted');
});

test('reviseProposal on a lost place is refused', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, ' for most edits', 0)),
    replacement: ' not',
  });
  await change(p.file, LINE, 'We found no effect.');
  await expect(
    reviseProposal(t.pool, store, users.reviewer.id, p.id, id, { replacement: ' never' }),
  ).rejects.toMatchObject({
    code: 'conflict',
    message: 'The place this was to be added at is no longer in the file. Make a new proposal.',
  });
});

test('an insertion stays fresh when the file is edited elsewhere, and at either end of the file', async () => {
  const p = await paper();
  const mid = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, ' for most edits', 0)),
    replacement: ' not',
  });
  const first = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await caret(p.file, 0)),
    replacement: '% top\n',
  });
  const last = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await caret(p.file, 'end')),
    replacement: '% bottom\n',
  });
  await change(p.file, 'Nothing else is claimed.', 'Something else.');
  expect((await proposals(p)).map((x) => x.stale)).toEqual([false, false, false]);
  for (const x of [mid, first, last]) await acceptProposal(t.pool, store, users.owner.id, p.id, x);
  expect(await saved(p)).toBe(
    `% top\n${MAIN.replace(' for most', ' not for most').replace('Nothing else is claimed.', 'Something else.')}% bottom\n`,
  );
});

test('a proposal that would break as LaTeX says so, and can still be accepted', async () => {
  const p = await paper();
  const latexOf = async (id: string) => (await proposals(p)).find((x) => x.id === id)!.latex;
  const make = async (words: string, replacement: string) =>
    propose(t.pool, store, users.reviewer.id, p.id, p.file, {
      ...(await ends(p.file, words)),
      replacement,
    });

  const percent = await make('40 ms', '40% less');
  expect(await latexOf(percent)).toEqual([
    'It has a % that is not written \\%: LaTeX reads the rest of the line as a comment, so “for most edits.” would be left out of the PDF.',
  ]);
  const escaped = await make('40 ms', '40\\% less');
  expect(await latexOf(escaped)).toEqual([]);
  const amp = await make('40 ms', 'R&D');
  expect(await latexOf(amp)).toEqual([
    'It has a bare &: LaTeX stops with an error there. Write \\&.',
  ]);
  const dollar = await make('40 ms', '$5');
  const [unfinished] = await latexOf(dollar);
  expect(unfinished).toMatch(/^It leaves LaTeX unfinished \(.+\)/);

  // Rejected: nothing to warn about.
  await closeProposal(t.pool, users.owner.id, p.id, amp, 'rejected');
  expect(await latexOf(amp)).toEqual([]);

  // Advisory: the owner can accept it, and the saved text has it.
  await acceptProposal(t.pool, store, users.owner.id, p.id, percent);
  expect(await saved(p)).toContain('below 40% less for most edits.');
  expect(await latexOf(percent)).toEqual([]);

  // Stale: the words changed under it.
  await change(p.file, 'Nothing else', 'Nothing more');
  const word = await make('Nothing more', 'Zero 5%');
  await change(p.file, 'Nothing more', 'Nothing at all');
  expect(await latexOf(word)).toEqual([]);
});

test('a proposal changed since it was last seen is not accepted, rejected or overwritten', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
  });
  const seenNow = async () => {
    const [{ expected, replacement }] = await proposals(p, 'owner');
    return { expected, replacement };
  };
  const seen0 = await seenNow();
  await reviseProposal(t.pool, store, users.reviewer.id, p.id, id, { replacement: 'above 400 ms' });

  // The owner decides on what the card showed: nothing is written, and it stays open.
  expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, id, seen0))).toBe(
    'conflict',
  );
  expect(await saved(p)).toBe(MAIN);
  expect((await proposals(p))[0].status).toBe('open');
  expect(await code(closeProposal(t.pool, users.owner.id, p.id, id, 'rejected', seen0))).toBe(
    'conflict',
  );
  expect((await proposals(p))[0].status).toBe('open');
  // A second person's change over the one they never saw.
  expect(
    await code(
      reviseProposal(t.pool, store, users.editor.id, p.id, id, {
        replacement: 'x',
        seen: seen0,
      }),
    ),
  ).toBe('conflict');
  expect((await proposals(p))[0].replacement).toBe('above 400 ms');
  // Not a pair of strings.
  for (const seen of ['nonsense', { expected: 'below 40 ms' }, null]) {
    expect(
      await code(
        reviseProposal(t.pool, store, users.editor.id, p.id, id, { replacement: 'x', seen }),
      ),
    ).toBe('invalid_input');
    expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, id, seen))).toBe(
      'invalid_input',
    );
    expect(await code(closeProposal(t.pool, users.owner.id, p.id, id, 'rejected', seen))).toBe(
      'invalid_input',
    );
  }
  expect((await proposals(p))[0]).toMatchObject({ status: 'open', replacement: 'above 400 ms' });

  // Having looked again, both go through, and what is written is exactly what was shown.
  await reviseProposal(t.pool, store, users.editor.id, p.id, id, {
    replacement: 'about 40 ms',
    seen: await seenNow(),
  });
  expect((await proposals(p))[0].replacement).toBe('about 40 ms');
  await acceptProposal(t.pool, store, users.owner.id, p.id, id, await seenNow());
  expect(await saved(p)).toBe(MAIN.replace('below 40 ms', 'about 40 ms'));
  // Asked again with what was seen before: the first time did it.
  expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, id, seen0))).toBe('ok');
  expect(await saved(p)).toBe(MAIN.replace('below 40 ms', 'about 40 ms'));

  // Without `seen`, as before.
  const other = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing')),
    replacement: 'Little',
  });
  await acceptProposal(t.pool, store, users.owner.id, p.id, other);
  expect(await saved(p)).toContain('Little else is claimed.');

  // An author withdraws their own proposal whatever they last saw.
  const mine = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'claimed')),
    replacement: 'shown',
  });
  await closeProposal(t.pool, users.reviewer.id, p.id, mine, 'dismissed', {
    expected: 'old',
    replacement: 'older',
  });
  expect((await proposals(p)).find((x) => x.id === mine)?.status).toBe('dismissed');
});

test('accepting two proposals on overlapping words: the second, on its old card, is refused', async () => {
  const p = await paper();
  const first = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40')),
    replacement: 'under 40',
  });
  const second = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, '40 ms')),
    replacement: '40 milliseconds',
  });
  const seen = async (which: string) => {
    const x = (await proposals(p, 'owner')).find((q) => q.id === which)!;
    return { expected: x.expected, replacement: x.replacement };
  };
  const [seen1, seen2] = [await seen(first), await seen(second)];
  expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, first, seen1))).toBe('ok');
  expect(await code(acceptProposal(t.pool, store, users.owner.id, p.id, second, seen2))).toBe(
    'conflict',
  );
  expect(await saved(p)).toBe(MAIN.replace('below 40', 'under 40'));
  expect((await proposals(p)).find((x) => x.id === second)?.status).toBe('open');
});

test('a reviewer cannot accept a proposal, and the text is unchanged', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
  });
  const [{ expected, replacement }] = await proposals(p, 'reviewer');
  expect(
    await code(
      acceptProposal(t.pool, store, users.reviewer.id, p.id, id, { expected, replacement }),
    ),
  ).toBe('permission_denied');
  expect(await saved(p)).toBe(MAIN);
  expect((await proposals(p))[0].status).toBe('open');
});

/** What this person was charged on this paper, one number for each charge. */
const charges = async (who: keyof typeof users, p: { id: string }) =>
  (
    await t.pool.query(
      'select bytes from web_edits where user_id = $1 and project_id = $2 order by id',
      [users[who].id, p.id],
    )
  ).rows.map((r) => Number(r.bytes));

/** An editor of their own, so that what other tests charged to the shared editor does not count. */
async function freshEditor(p: { id: string }, email: string) {
  const me = await t.signIn(email);
  const { token } = await invite(t.pool, users.owner.id, p.id, me.email, 'editor', 1000);
  await acceptInvitation(t.pool, me.id, token);
  return me;
}

test('accepts and undos are charged to the person deciding, until the hour is spent', async () => {
  const p = await paper();
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
  });
  const deciding = await freshEditor(p, 'deciding@example.org');
  const spent = async () =>
    (
      await t.pool.query('select bytes from web_edits where user_id = $1 order by id', [
        deciding.id,
      ])
    ).rows.map((r) => Number(r.bytes));
  // Room for two small edits and not a third.
  const budget = { bytesPerHour: 2 * WEB_EDIT_SMALL_FLOOR + 100 };
  await acceptProposal(t.pool, store, deciding.id, p.id, id, undefined, budget);
  await undoAccept(t.pool, store, deciding.id, p.id, id, budget);
  expect(await spent()).toEqual([WEB_EDIT_SMALL_FLOOR, WEB_EDIT_SMALL_FLOOR]);
  // The author of the proposal was charged nothing.
  expect(await charges('reviewer', p)).toEqual([]);
  const before = await saved(p);
  expect(await code(acceptProposal(t.pool, store, deciding.id, p.id, id, undefined, budget))).toBe(
    'conflict',
  );
  await expect(
    acceptProposal(t.pool, store, deciding.id, p.id, id, undefined, budget),
  ).rejects.toThrow('You have changed too much in the last hour. Try again in a little while.');
  expect(await saved(p)).toBe(before);
  expect((await proposals(p))[0].status).toBe('open');
  expect(await spent()).toHaveLength(2);
  // Someone else has an hour of their own.
  const other = await freshEditor(p, 'deciding-too@example.org');
  await acceptProposal(t.pool, store, other.id, p.id, id, undefined, budget);
  expect(await saved(p)).toBe(MAIN.replace('below 40 ms', 'under 40 ms'));
});

test('an accept whose edit is larger than what is left rolls back the edit and the status', async () => {
  const p = await paper();
  const big = 'x'.repeat(9000);
  const id = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: big,
  });
  // The floor fits, so the early check passes; the edit itself, of over 9000 bytes, does not.
  const budget = { bytesPerHour: WEB_EDIT_SMALL_FLOOR + 1000 };
  const me = await freshEditor(p, 'rollback@example.org');
  expect(await code(acceptProposal(t.pool, store, me.id, p.id, id, undefined, budget))).toBe(
    'conflict',
  );
  expect(await saved(p)).toBe(MAIN);
  expect((await proposals(p))[0].status).toBe('open');
  const rows = async () =>
    (await t.pool.query('select bytes from web_edits where user_id = $1', [me.id])).rows.map((r) =>
      Number(r.bytes),
    );
  expect(await rows()).toEqual([]);
  // Within a budget that holds it, the charge is the bytes appended, over the floor.
  await acceptProposal(t.pool, store, me.id, p.id, id, undefined, { bytesPerHour: 1_000_000 });
  const [cost] = await rows();
  expect(cost).toBeGreaterThan(9000);
});

test('a duplicate accept, a conflicting accept, an undo of an open proposal and a reviewer add no charge', async () => {
  const p = await paper();
  const first = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    replacement: 'under 40 ms',
  });
  const second = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else')),
    replacement: 'Little else',
  });
  // A reviewer's accept is refused, and refused first: no charge.
  expect(await code(acceptProposal(t.pool, store, users.reviewer.id, p.id, first))).toBe(
    'permission_denied',
  );
  expect(await charges('reviewer', p)).toEqual([]);
  // An undo of a proposal that is open does nothing and costs nothing.
  await undoAccept(t.pool, store, users.editor.id, p.id, first);
  expect(await charges('editor', p)).toEqual([]);
  await acceptProposal(t.pool, store, users.editor.id, p.id, first);
  expect(await charges('editor', p)).toHaveLength(1);
  // Asked again, as after a lost answer: still one charge.
  await acceptProposal(t.pool, store, users.editor.id, p.id, first);
  expect(await charges('editor', p)).toHaveLength(1);
  // The words of the second have changed under it: the accept is a conflict, and free.
  await change(p.file, 'Nothing else', 'Something else');
  expect(await code(acceptProposal(t.pool, store, users.editor.id, p.id, second))).toBe('conflict');
  expect(await charges('editor', p)).toHaveLength(1);
});

test('fifty accepts in a row by one person fit in the default hour, each at the small floor', async () => {
  const me = await t.signIn('bulk@example.org');
  const words = Array.from({ length: 50 }, (_, i) => `word${String(i).padStart(2, '0')}`);
  const body = `\\documentclass{article}\n\\begin{document}\n${words.join('\n')}\n\\end{document}\n`;
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(body) }]);
  const [project] = await importZip(t.pool, store, me.id, zip, 'Bulk');
  const [{ id: file }] = await listFiles(t.pool, me.id, project.id);
  const ids: string[] = [];
  for (const w of words)
    ids.push(
      await propose(t.pool, store, me.id, project.id, file, {
        ...(await ends(file, w)),
        replacement: `${w}x`,
      }),
    );
  const began = performance.now();
  for (const id of ids) await acceptProposal(t.pool, store, me.id, project.id, id);
  const took = performance.now() - began;
  // Printed for the record: how long fifty accepts took, one after another.
  console.info(`50 accepts in a row: ${Math.round(took)} ms (${Math.round(took / 50)} ms each)`);
  const rows = (
    await t.pool.query('select bytes from web_edits where user_id = $1 and project_id = $2', [
      me.id,
      project.id,
    ])
  ).rows.map((r) => Number(r.bytes));
  expect(rows).toHaveLength(50);
  expect(rows.every((b) => b >= WEB_EDIT_SMALL_FLOOR)).toBe(true);
});
