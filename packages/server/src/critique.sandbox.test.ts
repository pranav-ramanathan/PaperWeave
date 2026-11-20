// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
// No model is asked anything here: the answer is supplied by the test.
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { type Ask, MAX_PASSAGE, reviewPassage } from './critique.ts';
import { setLanguageSettings } from './grammar.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { acceptInvitation, invite, modelProcessing, setModelProcessing } from './projects.ts';
import { listProposals } from './proposals.ts';
import { loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { listThreads } from './threads.ts';

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

const PASSAGE =
  'Latency stays below 40~ms for most edits~\\cite{shapiro2011}. This proves that the protocol is fast. We think it scales.';
const SECRET = 'Unpublished: the reviewers must not see the grant number 12345.';
const MAIN = `\\documentclass{article}\n\\begin{document}\n${SECRET}\n\n${PASSAGE}\n\\end{document}\n`;
async function paper() {
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Critique');
  for (const who of ['editor', 'reviewer', 'viewer'] as const) {
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, who);
    await acceptInvitation(t.pool, users[who].id, token);
  }
  const [{ id: file }] = await listFiles(t.pool, users.owner.id, project.id);
  return { id: project.id, file };
}
async function ends(file: string, words: string) {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  const text = doc.getText(TEXT);
  const at = text.toString().indexOf(words);
  return {
    from: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, 0)),
    to: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, at + words.length, -1),
    ),
  };
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );
/** A stand-in for the model that remembers what it was sent. */
function fake(review: Awaited<ReturnType<Ask>>['review']) {
  const sent: Parameters<Ask>[0][] = [];
  const ask: Ask = async (request) => {
    sent.push(request);
    return { review, model: 'test-model' };
  };
  return { ask, sent };
}

test('a paper whose owner has not allowed it sends nothing', async () => {
  const p = await paper();
  const { ask, sent } = fake({ suggestions: [], questions: [] });
  const at = await ends(p.file, PASSAGE);
  // Off unless the owner turns it on, and only the owner can.
  expect(await modelProcessing(t.pool, users.viewer.id, p.id)).toBe(false);
  for (const who of ['owner', 'editor', 'reviewer'] as const)
    expect(await code(reviewPassage(t.pool, store, users[who].id, p.id, p.file, at, { ask }))).toBe(
      'permission_denied',
    );
  expect(await code(setModelProcessing(t.pool, users.editor.id, p.id, true))).toBe(
    'permission_denied',
  );
  expect(await code(setModelProcessing(t.pool, users.outsider.id, p.id, true))).toBe('not_found');
  expect(await code(setModelProcessing(t.pool, users.owner.id, p.id, 'yes'))).toBe('invalid_input');
  expect(sent).toEqual([]);

  // Allowed by the owner, but the deployment names no provider: still nothing to send to.
  await setModelProcessing(t.pool, users.owner.id, p.id, true);
  expect(
    await code(reviewPassage(t.pool, store, users.owner.id, p.id, p.file, at, { provider: '' })),
  ).toBe('unavailable');
  // Turned off again, it is off.
  await setModelProcessing(t.pool, users.owner.id, p.id, false);
  expect(await code(reviewPassage(t.pool, store, users.owner.id, p.id, p.file, at, { ask }))).toBe(
    'permission_denied',
  );
  expect(sent).toEqual([]);
});

test('a review sends the passage alone and comes back as proposals and questions', async () => {
  const p = await paper();
  await setModelProcessing(t.pool, users.owner.id, p.id, true);
  await setLanguageSettings(t.pool, users.owner.id, p.id, { glossary: ['Weavely'] });
  const { ask, sent } = fake({
    suggestions: [
      // A rewording.
      {
        before: 'We think it scales.',
        after: 'We expect it to scale.',
        reason: 'Says the same more directly.',
        evidence: ['shapiro2011'],
      },
      // One that changes the claim, against its instructions: a number and a certainty.
      {
        before: 'below 40~ms for most edits',
        after: 'below 30~ms for all edits',
        reason: 'Tighter.',
        evidence: [],
      },
      // Not a quote of the passage; and one that would change nothing.
      { before: 'This text is not there.', after: 'x', reason: '', evidence: [] },
      { before: 'This proves', after: 'This proves', reason: '', evidence: [] },
    ],
    questions: [
      { about: 'This proves that the protocol is fast.', question: 'Against which baseline?' },
      { about: 'somewhere else entirely', question: 'Is the whole passage needed?' },
    ],
  });
  const done = await reviewPassage(
    t.pool,
    store,
    users.reviewer.id,
    p.id,
    p.file,
    await ends(p.file, PASSAGE),
    { ask },
  );
  expect(done).toEqual({ proposed: 2, asked: 2, left: 2 });
  // The model was sent the passage and the paper's own words. Nothing else of the file.
  expect(sent).toEqual([{ passage: PASSAGE, glossary: ['Weavely'] }]);
  expect(JSON.stringify(sent)).not.toContain('grant number');

  // Nothing was written to the paper.
  const file = (await readZip(await exportZip(t.pool, store, users.owner.id, p.id))).entries[0];
  expect(Buffer.from(file.bytes).toString()).toBe(MAIN);

  const proposals = await listProposals(t.pool, store, users.owner.id, p.id);
  expect(proposals).toMatchObject([
    {
      expected: 'We think it scales.',
      replacement: 'We expect it to scale.',
      reason: 'Says the same more directly.',
      status: 'open',
      origin: 'critique',
      madeBy: 'test-model with claims-1',
      evidence: ['shapiro2011'],
      author: 'reviewer@example.org',
    },
    { expected: 'below 40~ms for most edits', origin: 'critique' },
  ]);
  // The change of claim is flagged before anyone decides on it.
  expect(proposals[1].flags).toEqual(
    expect.arrayContaining([
      'The numbers differ: 40 → 30.',
      'How much it covers may have changed: most → all.',
    ]),
  );
  // The questions are threads on the text they are about; the one whose text could not be
  // found is about the whole passage.
  const threads = await listThreads(t.pool, store, users.owner.id, p.id);
  expect(threads.map((th) => [th.excerpt, th.comments[0].body])).toEqual([
    [
      'This proves that the protocol is fast.',
      'Question from the model review: Against which baseline?',
    ],
    [PASSAGE, 'Question from the model review: Is the whole passage needed?'],
  ]);
});

test('a review is asked for by people who may propose, of a passage of a sensible size', async () => {
  const p = await paper();
  const other = await paper();
  await setModelProcessing(t.pool, users.owner.id, p.id, true);
  const { ask, sent } = fake({ suggestions: [], questions: [] });
  const at = await ends(p.file, PASSAGE);
  const review = (who: keyof typeof users, input: object = at, project = p.id, file = p.file) =>
    code(reviewPassage(t.pool, store, users[who].id, project, file, input as typeof at, { ask }));
  expect(await review('viewer')).toBe('permission_denied');
  expect(await review('outsider')).toBe('not_found');
  expect(await review('owner', at, p.id, other.file)).toBe('not_found');
  // The other paper's owner has not allowed it.
  expect(await review('owner', await ends(other.file, PASSAGE), other.id, other.file)).toBe(
    'permission_denied',
  );
  expect(await review('owner', await ends(p.file, 'We think'))).toBe('invalid_input');
  expect(await review('owner', { from: 'x', to: at.to })).toBe('invalid_input');
  expect(MAX_PASSAGE).toBeLessThanOrEqual(6000);
  expect(sent).toEqual([]);
  expect(await review('editor')).toBe('ok');
  expect(sent).toHaveLength(1);
  // A paper may ask only so often in an hour. Past that, nothing more is sent.
  const limited = () =>
    code(reviewPassage(t.pool, store, users.owner.id, p.id, p.file, at, { ask, perHour: 2 }));
  expect(await limited()).toBe('ok');
  expect(await limited()).toBe('conflict');
  expect(sent).toHaveLength(2);
});

test('evidence is stored cut to 500 characters each, and ten of them', async () => {
  const p = await paper();
  await setModelProcessing(t.pool, users.owner.id, p.id, true);
  const { ask } = fake({
    suggestions: [
      {
        before: 'We think it scales.',
        after: 'We expect it to scale.',
        reason: 'Says the same more directly.',
        evidence: Array.from({ length: 12 }, (_, i) => `${i}`.repeat(501)),
      },
    ],
    questions: [],
  });
  await reviewPassage(t.pool, store, users.reviewer.id, p.id, p.file, await ends(p.file, PASSAGE), {
    ask,
  });
  const [proposal] = await listProposals(t.pool, store, users.owner.id, p.id);
  expect(proposal.evidence).toHaveLength(10);
  expect(proposal.evidence.every((e: string) => e.length === 500)).toBe(true);
});
