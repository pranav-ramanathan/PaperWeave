// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { exportZip, importZip, listFiles } from './import.ts';
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
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, who);
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
