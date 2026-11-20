// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
// What an open editor asks every few seconds: how few statements, and what its marks say.
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { latestBuilds, requestBuild } from './builds.ts';
import { importZip, listFiles } from './import.ts';
import { acceptInvitation, invite } from './projects.ts';
import { acceptProposal, closeProposal, propose, reviseProposal } from './proposals.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { reply, setThreadStatus, startThread } from './threads.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
const users = {} as Record<'owner' | 'viewer' | 'outsider', { id: string; email: string }>;
let project: string;
let file: string;

const MAIN =
  '\\documentclass{article}\n\\begin{document}\nLatency stays below 40 ms for most edits.\nNothing else is claimed.\n\\end{document}\n';

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  [{ id: project }] = await importZip(t.pool, store, users.owner.id, zip, 'Poll');
  const { token } = await invite(t.pool, users.owner.id, project, users.viewer.email, 'viewer');
  await acceptInvitation(t.pool, users.viewer.id, token);
  [{ id: file }] = await listFiles(t.pool, users.owner.id, project);
});
afterAll(() => t.close());

/** Count the statements the pool is given while `fn` runs. */
async function counting<T>(fn: () => Promise<T>) {
  const query = t.pool.query.bind(t.pool);
  let n = 0;
  (t.pool as { query: unknown }).query = (...args: unknown[]) => {
    n++;
    return (query as (...a: unknown[]) => unknown)(...args);
  };
  try {
    return { result: await fn(), statements: n };
  } finally {
    (t.pool as { query: unknown }).query = query;
  }
}
async function ends(words: string) {
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
const marks = async () => {
  const { edits, review } = await latestBuilds(t.pool, users.owner.id, project);
  return { edits, review };
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test('a poll for a member is two statements, whether or not the newest build has a PDF', async () => {
  // No build at all.
  let seen = await counting(() => latestBuilds(t.pool, users.owner.id, project));
  expect(seen.result).toMatchObject({ latest: null, lastGood: null });
  expect(seen.statements).toBeLessThanOrEqual(2);
  // A build with a PDF, then a newer one without.
  await requestBuild(t.pool, users.owner.id, project);
  await t.pool.query(
    "update builds set status = 'succeeded', pdf_digest = 'abc', finished_at = now() where project_id = $1",
    [project],
  );
  seen = await counting(() => latestBuilds(t.pool, users.owner.id, project));
  expect(seen.result.latest).toMatchObject({ status: 'succeeded', hasPdf: true });
  expect(seen.result.lastGood?.id).toBe(seen.result.latest?.id);
  expect(seen.statements).toBeLessThanOrEqual(2);
  await requestBuild(t.pool, users.owner.id, project);
  seen = await counting(() => latestBuilds(t.pool, users.viewer.id, project));
  expect(seen.result.latest).toMatchObject({ status: 'queued', hasPdf: false });
  expect(seen.result.lastGood).toMatchObject({ status: 'succeeded', hasPdf: true });
  expect(seen.result.lastGood?.id).not.toBe(seen.result.latest?.id);
  expect(seen.statements).toBeLessThanOrEqual(2);
});

test('someone not on the paper is told there is no such paper, and a viewer may look', async () => {
  expect(await code(latestBuilds(t.pool, users.outsider.id, project))).toBe('not_found');
  expect(await code(latestBuilds(t.pool, users.viewer.id, project))).toBe('ok');
  expect(
    await code(latestBuilds(t.pool, users.owner.id, '00000000-0000-4000-8000-000000000000')),
  ).toBe('not_found');
});

test('the review mark moves with every comment and proposal, and with nothing else', async () => {
  const same = async (what: string) => {
    const a = await marks();
    const b = await marks();
    expect(b, `${what}: unchanged without a change`).toEqual(a);
    return a;
  };
  const moved = async (was: Awaited<ReturnType<typeof marks>>, what: string) => {
    const now = await same(what);
    expect(now.review, what).not.toBe(was.review);
    return now;
  };
  let m = await same('start');
  // Things that are not comments or proposals leave it as it was.
  await requestBuild(t.pool, users.owner.id, project);
  expect((await same('a build')).review).toBe(m.review);

  const started = await startThread(t.pool, store, users.owner.id, project, file, {
    ...(await ends('below 40 ms')),
    body: 'Median or tail?',
  });
  m = await moved(m, 'a thread is started');
  await reply(t.pool, users.owner.id, project, started.id, { body: 'Tail, then.' });
  m = await moved(m, 'a reply');
  await setThreadStatus(t.pool, users.owner.id, project, started.id, 'resolved');
  m = await moved(m, 'a thread is resolved');
  await setThreadStatus(t.pool, users.owner.id, project, started.id, 'open');
  m = await moved(m, 'a thread is opened again');

  const p = await propose(t.pool, store, users.owner.id, project, file, {
    ...(await ends('below 40 ms')),
    replacement: 'under 40 ms',
    reason: 'Shorter.',
  });
  m = await moved(m, 'a proposal is made');
  await reviseProposal(t.pool, store, users.owner.id, project, p, { replacement: 'under 41 ms' });
  m = await moved(m, 'a proposal is revised');
  await reviseProposal(t.pool, store, users.owner.id, project, p, {
    replacement: 'under 41 ms',
    reason: 'Because.',
  });
  m = await moved(m, 'a proposal gets a reason');
  await closeProposal(t.pool, users.owner.id, project, p, 'rejected');
  m = await moved(m, 'a proposal is rejected');
  const q = await propose(t.pool, store, users.owner.id, project, file, {
    ...(await ends('below 40 ms')),
    replacement: 'under 40 ms',
    reason: '',
  });
  m = await moved(m, 'another proposal');
  expect(await code(acceptProposal(t.pool, store, users.owner.id, project, q))).toBe('ok');
  const after = await same('accepted');
  expect(after.review).not.toBe(m.review);
  // Typing moves the other mark, and not this one.
  await editFile(t.pool, store, file, users.owner.id, (text) => text.insert(text.length, '% x\n'));
  const typed = await same('typing');
  expect(typed.edits).not.toBe(after.edits);
  expect(typed.review).toBe(after.review);
});
