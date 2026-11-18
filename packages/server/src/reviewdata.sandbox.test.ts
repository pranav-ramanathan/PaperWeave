// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { exportZip, importReport, importZip, listFiles } from './import.ts';
import { acceptInvitation, invite } from './projects.ts';
import { acceptProposal, closeProposal, listProposals, propose } from './proposals.ts';
import { exportReview, locateQuote, REVIEW_FILE } from './reviewdata.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { listThreads, reply, setThreadStatus, startThread } from './threads.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
const users = {} as Record<
  'owner' | 'reviewer' | 'viewer' | 'importer' | 'outsider',
  { id: string; email: string }
>;

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'reviewer', 'viewer', 'importer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
});
afterAll(() => t.close());

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Latency stays below 40 ms for most edits.',
  'The first run was slow. The second run was fast.',
  'Nothing else is claimed.',
  'This sentence will be cut.',
  '\\end{document}',
  '',
].join('\n');
async function paper() {
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Review data');
  for (const who of ['reviewer', 'viewer'] as const) {
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, who);
    await acceptInvitation(t.pool, users[who].id, token);
  }
  const [{ id: file }] = await listFiles(t.pool, users.owner.id, project.id);
  return { id: project.id, file };
}
/** The two ends of a stretch of the saved text; `nth` picks among several of the same words. */
async function ends(file: string, words: string, nth = 0) {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  const text = doc.getText(TEXT);
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.toString().indexOf(words, at + 1);
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
/** What must survive the trip: everything but the IDs and positions of this copy. */
const review = async (projectId: string, as: string) => ({
  threads: (await listThreads(t.pool, store, as, projectId)).map((th) => ({
    path: th.path,
    excerpt: th.excerpt,
    before: th.before,
    after: th.after,
    state: th.state,
    now: th.now,
    status: th.status,
    startedBy: th.startedBy,
    createdAt: th.createdAt,
    comments: th.comments.map((c) => [c.author, c.body, c.createdAt]),
  })),
  proposals: (await listProposals(t.pool, store, as, projectId)).map((p) => ({
    path: p.path,
    expected: p.expected,
    replacement: p.replacement,
    reason: p.reason,
    status: p.status,
    stale: p.stale,
    now: p.now,
    flags: p.flags,
    author: p.author,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    origin: p.origin,
  })),
});

test('a paper leaves with its review and arrives with it', async () => {
  const p = await paper();
  // Two threads: one answered and resolved, one whose text is then cut.
  const first = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Median or tail?',
  });
  await reply(t.pool, users.owner.id, p.id, first.id, { body: 'The 95th percentile.' });
  await setThreadStatus(t.pool, users.owner.id, p.id, first.id, 'resolved');
  await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'will be cut')),
    body: 'Do we need this?',
  });
  // Four proposals: open on words that are in the file twice, accepted, rejected, and open.
  await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'run was', 1)),
    replacement: 'run, by contrast, was',
    reason: 'Marks the contrast.',
  });
  const taken = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else')),
    replacement: 'No more',
  });
  const refused = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Latency')),
    replacement: 'Delay',
  });
  await propose(t.pool, store, users.owner.id, p.id, p.file, {
    ...(await ends(p.file, '40 ms')),
    replacement: '30 ms',
  });
  await acceptProposal(t.pool, store, users.owner.id, p.id, taken);
  await closeProposal(t.pool, users.owner.id, p.id, refused, 'rejected');
  await editFile(t.pool, store, p.file, users.owner.id, (text) => {
    const at = text.toString().indexOf('This sentence will be cut.\n');
    text.delete(at, 'This sentence will be cut.\n'.length);
  });

  // The paper's own download has no review in it unless it is asked for.
  const plain = await readZip(await exportZip(t.pool, store, users.owner.id, p.id));
  expect(plain.review).toEqual([]);
  const zip = await exportZip(t.pool, store, users.owner.id, p.id, { review: true });
  const packed = await readZip(zip);
  expect(packed.entries.map((e) => e.path)).toEqual(['main.tex']);
  expect(packed.review.map((e) => e.path)).toEqual([REVIEW_FILE]);
  // Nothing in it that only this copy could use.
  const data = Buffer.from(packed.review[0].bytes).toString();
  expect(data).not.toContain(p.id);
  expect(data).not.toContain(p.file);

  // Someone else imports the archive. The review is there, placed by its words.
  const [arrived] = await importZip(t.pool, store, users.importer.id, zip, 'Arrived');
  expect((await importReport(t.pool, users.importer.id, arrived.id))!.review).toEqual({
    threads: 2,
    proposals: 4,
    detached: 1,
    missing: [],
  });
  const was = await review(p.id, users.owner.id);
  const now = await review(arrived.id, users.importer.id);
  expect(now).toEqual(was);
  // What that covers, spelt out: states, the people as names, and the flags.
  expect(now.threads.map((th) => [th.state, th.status, th.startedBy])).toEqual([
    ['attached', 'resolved', 'reviewer@example.org'],
    ['detached', 'open', 'reviewer@example.org'],
  ]);
  expect(now.threads[0].comments.map((c) => c.slice(0, 2))).toEqual([
    ['reviewer@example.org', 'Median or tail?'],
    ['owner@example.org', 'The 95th percentile.'],
  ]);
  expect(now.proposals.map((x) => [x.expected, x.status, x.now])).toEqual([
    ['run was', 'open', 'run was'],
    ['Nothing else', 'accepted', 'No more'],
    ['Latency', 'rejected', 'Latency'],
    ['40 ms', 'open', '40 ms'],
  ]);
  expect(now.proposals[3].flags).toEqual(['The numbers differ: 40 → 30.']);
  // The open proposal on the second "run was" is on the second, and can be accepted there.
  const open = (await listProposals(t.pool, store, users.importer.id, arrived.id))[0];
  await acceptProposal(t.pool, store, users.importer.id, arrived.id, open.id);
  const files = (await readZip(await exportZip(t.pool, store, users.importer.id, arrived.id)))
    .entries;
  expect(Buffer.from(files[0].bytes).toString()).toContain(
    'The first run was slow. The second run, by contrast, was fast.',
  );

  expect(await code(exportReview(t.pool, store, users.viewer.id, p.id))).toBe('permission_denied');
  expect(await code(exportReview(t.pool, store, users.outsider.id, p.id))).toBe('not_found');
});

test('review that cannot be placed is reported, and never stops the paper coming in', async () => {
  const data = {
    format: 'paperweave-review-1',
    paper: 'Elsewhere',
    exported: '2026-01-01T00:00:00.000Z',
    threads: [
      {
        file: 'gone.tex',
        quote: 'somewhere',
        before: '',
        after: '',
        status: 'open',
        startedBy: 'a@example.org',
        createdAt: '2026-01-01T00:00:00.000Z',
        comments: [{ author: 'a@example.org', body: 'Hm.', createdAt: '2026-01-01T00:00:00.000Z' }],
      },
    ],
    proposals: [
      {
        file: 'main.tex',
        expected: 'words that are not in the file',
        replacement: 'x',
        before: '',
        after: '',
        reason: '',
        status: 'open',
        author: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        decidedAt: null,
        origin: 'person',
        madeBy: null,
        evidence: [],
      },
    ],
  };
  // Built by hand: a ZIP with the paper and a review file beside it.
  const { default: yazl } = await import('yazl');
  const zipWith = (review: string) =>
    new Promise<Buffer>((resolve) => {
      const z = new yazl.ZipFile();
      z.addBuffer(Buffer.from(MAIN), 'main.tex');
      z.addBuffer(Buffer.from(review), REVIEW_FILE);
      const chunks: Buffer[] = [];
      z.outputStream.on('data', (c: Buffer) => chunks.push(c));
      z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
      z.end();
    });
  const [placed] = await importZip(
    t.pool,
    store,
    users.importer.id,
    await zipWith(JSON.stringify(data)),
    'Partly',
  );
  expect((await importReport(t.pool, users.importer.id, placed.id))!.review).toEqual({
    threads: 0,
    proposals: 0,
    detached: 0,
    missing: [
      'A thread on “somewhere”: the paper has no file gone.tex.',
      'A proposal to change “words that are not in the file” in main.tex: that text is not in the file, or is there more than once.',
    ],
  });
  // Not review data at all, and review data that says things it may not.
  for (const broken of ['{ not json', JSON.stringify({ ...data, format: 'something-else' })]) {
    const [made] = await importZip(t.pool, store, users.importer.id, await zipWith(broken), 'Bad');
    expect((await importReport(t.pool, users.importer.id, made.id))!.review).toEqual({
      threads: 0,
      proposals: 0,
      detached: 0,
      missing: ['The review data in the archive could not be read, so none was brought in.'],
    });
    expect((await listFiles(t.pool, users.importer.id, made.id)).map((f) => f.path)).toEqual([
      'main.tex',
    ]);
  }
});

test('words are found where they stand, or by what stands around them', () => {
  const text = 'The first run was slow. The second run was fast.';
  expect(locateQuote(text, 'slow', '', '')).toBe(18);
  expect(locateQuote(text, 'run was', 'The second ', ' fast.')).toBe(35);
  expect(locateQuote(text, 'run was', 'The first ', ' slow.')).toBe(10);
  // Twice, and nothing to tell them apart by.
  expect(locateQuote(text, 'run was', '', '')).toBe(-1);
  expect(locateQuote(text, 'run was', 'The third ', ' odd.')).toBe(-1);
  expect(locateQuote(text, 'never there', '', '')).toBe(-1);
  // A place with no words of its own: between what stood before and after it.
  expect(locateQuote(text, '', 'slow. ', 'The second')).toBe(24);
  expect(locateQuote(text, '', '', '')).toBe(-1);
});
