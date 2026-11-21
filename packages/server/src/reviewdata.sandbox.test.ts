// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { exportZip, importReport, importZip, listFiles } from './import.ts';
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
import { exportReview, locateQuote, REVIEW_FILE } from './reviewdata.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';
import { deleteComment, listThreads, reply, setThreadStatus, startThread } from './threads.ts';

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
    decidedBy: p.decidedBy,
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
  // A thread arrives with what stands around its words now (the accepted change is in it), not
  // with what stood there when it was started.
  expect(now.threads[0].after).toContain('No more is cla');
  expect(was.threads[0].after).toContain('Nothing else i');
  for (const side of [was, now]) for (const th of side.threads) th.after = th.before = '';
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

// ---- What the app can write must come back in whole; what travels is how it reads now. ----

const NOW = '2026-01-01T00:00:00.000Z';
/** A ZIP of the paper with the given text as its review file. */
const zipWith = (review: string) =>
  writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: REVIEW_FILE, bytes: Buffer.from(review) },
  ]);
/** The paper exported with its review and imported again by someone else. */
async function trip(projectId: string) {
  const zip = await exportZip(t.pool, store, users.owner.id, projectId, { review: true });
  const [arrived] = await importZip(t.pool, store, users.importer.id, zip, 'Arrived');
  return {
    id: arrived.id,
    report: (await importReport(t.pool, users.importer.id, arrived.id))!,
  };
}
const replaceIn = (file: string, from: string, to: string, by = users.owner.id) =>
  editFile(t.pool, store, file, by, (text) => {
    const at = text.toString().indexOf(from);
    text.delete(at, from.length);
    text.insert(at, to);
  });

test('a critique proposal with long evidence does not cost the file its threads', async () => {
  const p = await paper();
  for (const words of ['below 40 ms', 'Nothing else'])
    await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
      ...(await ends(p.file, words)),
      body: 'Hm.',
    });
  const made = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else')),
    replacement: 'No more',
  });
  await t.pool.query("update proposals set origin = 'critique', evidence = $2 where id = $1", [
    made,
    JSON.stringify(['k'.repeat(501)]),
  ]);
  const { id, report } = await trip(p.id);
  expect(report.review).toMatchObject({ threads: 2, proposals: 1, missing: [] });
  const [arrived] = await listProposals(t.pool, store, users.importer.id, id);
  expect(arrived.evidence).toEqual(['k'.repeat(500)]);
});

test('many comments and a long address arrive whole, the name trimmed', async () => {
  const p = await paper();
  const long = `${'a'.repeat(309)}@example.org`;
  expect(long.length).toBe(321);
  const author = await t.signIn(long);
  await t.pool.query(
    "insert into project_members (project_id, user_id, role) values ($1,$2,'reviewer')",
    [p.id, author.id],
  );
  const { id } = await startThread(t.pool, store, author.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'First.',
  });
  await t.pool.query(
    `insert into thread_comments (thread_id, author, body)
     select $1, $2, 'More ' || n from generate_series(1, 500) n`,
    [id, users.owner.id],
  );
  const { id: arrived, report } = await trip(p.id);
  expect(report.review).toMatchObject({ threads: 1, missing: [] });
  const [thread] = await listThreads(t.pool, store, users.importer.id, arrived);
  expect(thread.comments).toHaveLength(501);
  expect(thread.startedBy).toBe(long.slice(0, 320));
  expect(thread.comments[0].author).toBe(long.slice(0, 320));
});

test('comments of an imported thread keep the order the file gives, ties or not', async () => {
  const thread = (comments: { author: null; body: string; createdAt: string }[]) => ({
    file: 'main.tex',
    quote: 'below 40 ms',
    before: '',
    after: '',
    status: 'open',
    startedBy: null,
    createdAt: NOW,
    comments,
  });
  const ties = Array.from({ length: 20 }, (_, i) => ({
    author: null,
    body: String(i + 1),
    createdAt: NOW,
  }));
  const apart = [
    '2026-01-01T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
    '2026-03-01T12:00:00.000Z',
  ];
  const data = {
    format: 'paperweave-review-1',
    paper: 'Hand-written',
    exported: NOW,
    threads: [
      thread(ties),
      thread(apart.map((createdAt, i) => ({ author: null, body: `d${i}`, createdAt }))),
    ],
    proposals: [],
  };
  const [made] = await importZip(
    t.pool,
    store,
    users.importer.id,
    await zipWith(JSON.stringify(data)),
    'Ties',
  );
  const threads = await listThreads(t.pool, store, users.importer.id, made.id);
  expect(threads).toHaveLength(2);
  const tied = threads.find((th) => th.comments[0].body === '1')!;
  expect(tied.comments.map((c) => c.body)).toEqual(ties.map((c) => c.body));
  const distinct = threads.find((th) => th !== tied)!;
  expect(distinct.comments.map((c) => c.body)).toEqual(['d0', 'd1', 'd2']);
  expect(distinct.comments.map((c) => new Date(c.createdAt).toISOString())).toEqual(apart);
});

test('an item that cannot be read costs only itself', async () => {
  const good = {
    file: 'main.tex',
    quote: 'below 40 ms',
    before: '',
    after: '',
    status: 'open',
    startedBy: null,
    createdAt: NOW,
    comments: [{ author: null, body: 'Fine.', createdAt: NOW }],
  };
  const data = {
    format: 'paperweave-review-1',
    paper: 'Hand-written',
    exported: NOW,
    threads: [good, { ...good, comments: [] }],
    proposals: [
      {
        file: 'main.tex',
        expected: 'Nothing else',
        replacement: 'No more',
        before: '',
        after: '',
        reason: '',
        status: 'open',
        author: null,
        createdAt: NOW,
        decidedAt: null,
        origin: 'person',
        madeBy: null,
        evidence: [],
      },
    ],
  };
  const [made] = await importZip(
    t.pool,
    store,
    users.importer.id,
    await zipWith(JSON.stringify(data)),
    'H',
  );
  expect((await importReport(t.pool, users.importer.id, made.id))!.review).toEqual({
    threads: 1,
    proposals: 1,
    detached: 0,
    missing: ['A thread in the archive could not be read, and was left out.'],
  });
});

test('a review file written before these fields existed still comes in whole', async () => {
  const old =
    '{"format":"paperweave-review-1","paper":"Old","exported":"2026-01-01T00:00:00.000Z",' +
    '"threads":[{"file":"main.tex","quote":"below 40 ms","before":"stays ","after":" for most",' +
    '"status":"resolved","startedBy":"a@example.org","createdAt":"2026-01-01T00:00:00.000Z",' +
    '"comments":[{"author":"a@example.org","body":"Hm.","createdAt":"2026-01-01T00:00:00.000Z"}]}],' +
    '"proposals":[{"file":"main.tex","expected":"Nothing else","replacement":"No more","before":"",' +
    '"after":" is claimed","reason":"Short.","status":"open","author":null,' +
    '"createdAt":"2026-01-01T00:00:00.000Z","decidedAt":null,"origin":"person","madeBy":null,"evidence":[]}]}';
  const [made] = await importZip(t.pool, store, users.importer.id, await zipWith(old), 'Old');
  expect((await importReport(t.pool, users.importer.id, made.id))!.review).toEqual({
    threads: 1,
    proposals: 1,
    detached: 0,
    missing: [],
  });
  const [arrived] = await listProposals(t.pool, store, users.importer.id, made.id);
  expect(arrived.decidedBy).toBeNull();
});

test('who decided a proposal arrives with it', async () => {
  const p = await paper();
  const taken = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else')),
    replacement: 'No more',
  });
  const refused = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Latency')),
    replacement: 'Delay',
  });
  await acceptProposal(t.pool, store, users.owner.id, p.id, taken);
  await closeProposal(t.pool, users.owner.id, p.id, refused, 'rejected');
  const { id } = await trip(p.id);
  const arrived = await listProposals(t.pool, store, users.importer.id, id);
  expect(arrived.map((a) => [a.status, a.decidedBy]).sort()).toEqual([
    ['accepted', users.owner.email],
    ['rejected', users.owner.email],
  ]);
});

test('a thread whose words were edited arrives on the words as they now read', async () => {
  const p = await paper();
  await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Median or tail?',
  });
  await replaceIn(p.file, '40', '45');
  const was = (await listThreads(t.pool, store, users.owner.id, p.id))[0];
  expect([was.state, was.now]).toEqual(['changed', 'below 45 ms']);
  const { id } = await trip(p.id);
  const [now] = await listThreads(t.pool, store, users.importer.id, id);
  expect([now.state, now.now]).toEqual(['attached', 'below 45 ms']);
});

test('a thread detached where it came from is not caught by words typed elsewhere', async () => {
  const p = await paper();
  await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'will be cut')),
    body: 'Do we need this?',
  });
  await replaceIn(p.file, 'This sentence will be cut.\n', '');
  await replaceIn(p.file, 'Nothing else is claimed.', 'Nothing else is claimed; it will be cut.');
  expect((await listThreads(t.pool, store, users.owner.id, p.id))[0].state).toBe('detached');
  const { id, report } = await trip(p.id);
  expect(report.review).toMatchObject({ threads: 1, detached: 1 });
  const [now] = await listThreads(t.pool, store, users.importer.id, id);
  expect([now.state, now.excerpt]).toEqual(['detached', 'will be cut']);
});

test('an accepted proposal that had gone stale arrives stale', async () => {
  const p = await paper();
  const made = await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'Nothing else')),
    replacement: 'No more',
  });
  await acceptProposal(t.pool, store, users.owner.id, p.id, made);
  await replaceIn(p.file, 'No more', 'No less');
  expect((await listProposals(t.pool, store, users.owner.id, p.id))[0]).toMatchObject({
    status: 'accepted',
    stale: true,
  });
  const { id } = await trip(p.id);
  const [now] = await listProposals(t.pool, store, users.importer.id, id);
  expect(now).toMatchObject({ status: 'accepted', stale: true, replacement: 'No more' });
  // Undoing the accept is refused here as it is where this came from.
  expect(await code(undoAccept(t.pool, store, users.importer.id, id, now.id))).toBe('conflict');
});

test('a deleted comment, and a thread with none left, do not leave with the review', async () => {
  const p = await paper();
  const kept = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'below 40 ms')),
    body: 'Median or tail?',
  });
  await reply(t.pool, users.reviewer.id, p.id, kept.id, { body: 'Pasted by mistake.' });
  const gone = await startThread(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'will be cut')),
    body: 'Wrong paper.',
  });
  const all = await listThreads(t.pool, store, users.owner.id, p.id);
  await deleteComment(t.pool, users.owner.id, p.id, kept.id, all[0].comments[1].id);
  await deleteComment(t.pool, users.owner.id, p.id, gone.id, all[1].comments[0].id);
  const out = await exportReview(t.pool, store, users.owner.id, p.id);
  expect(out.threads).toHaveLength(1);
  expect(out.threads[0].comments.map((c) => c.body)).toEqual(['Median or tail?']);
});

/** A place between two characters, as an editor with the caret there would send it. */
async function caretAfter(file: string, words: string) {
  const { to } = await ends(file, words);
  return { from: to, to };
}
const saved = async (file: string) => {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  return doc.getText(TEXT).toString();
};
const LINE = 'Latency stays below 40 ms for most edits.';
/** An insertion proposal whose place is then deleted, and the paper's trip. */
async function lostPlace() {
  const p = await paper();
  await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await caretAfter(p.file, 'below 40 ms')),
    replacement: ' (95th percentile)',
  });
  await replaceIn(p.file, LINE, 'We found no effect.');
  return p;
}
/** "slow" is proposed to become "sluggish", then changed to "quick" in the source. */
async function wordChanged(typedElsewhere: boolean) {
  const p = await paper();
  await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await ends(p.file, 'slow')),
    replacement: 'sluggish',
  });
  await replaceIn(p.file, 'slow', 'quick');
  if (typedElsewhere)
    await replaceIn(p.file, 'Nothing else is claimed.', 'Nothing else is slow, it is claimed.');
  return p;
}

test('an insertion whose place was deleted does not arrive fresh', async () => {
  const p = await lostPlace();
  expect((await listProposals(t.pool, store, users.owner.id, p.id))[0]).toMatchObject({
    stale: true,
    placeLost: true,
  });
  const { id, report } = await trip(p.id);
  const arrived = await listProposals(t.pool, store, users.importer.id, id);
  expect(arrived.filter((x) => x.status === 'open' && !x.stale)).toEqual([]);
  expect(report.review).toMatchObject({ proposals: 0 });
  expect(report.review?.missing).toEqual([
    'A proposal to add “ (95th percentile)” in main.tex: the place it was to be added at was no longer in the file.',
  ]);
  const [file] = await listFiles(t.pool, users.importer.id, id);
  expect(await saved(file.id)).toBe(MAIN.replace(LINE, 'We found no effect.'));
});

test('a stale proposal on words typed elsewhere stays stale and cannot be accepted', async () => {
  const p = await wordChanged(true);
  expect((await listProposals(t.pool, store, users.owner.id, p.id))[0].stale).toBe(true);
  const { id } = await trip(p.id);
  const [now] = await listProposals(t.pool, store, users.importer.id, id);
  expect(now).toMatchObject({ status: 'open', stale: true, now: '' });
  const [file] = await listFiles(t.pool, users.importer.id, id);
  const before = await saved(file.id);
  expect(await code(acceptProposal(t.pool, store, users.importer.id, id, now.id))).toBe('conflict');
  expect(await saved(file.id)).toBe(before);
});

test('a stale proposal whose words are gone still arrives, and can find them again', async () => {
  const p = await wordChanged(false);
  const { id, report } = await trip(p.id);
  expect(report.review).toMatchObject({ proposals: 1 });
  const [now] = await listProposals(t.pool, store, users.importer.id, id);
  expect(now).toMatchObject({ status: 'open', stale: true });
  const [file] = await listFiles(t.pool, users.importer.id, id);
  // The closed-up stretch is not revised into a proposal about wherever it sits.
  expect(
    await code(reviseProposal(t.pool, store, users.importer.id, id, now.id, { replacement: 'x' })),
  ).toBe('conflict');
  await replaceIn(file.id, 'quick', 'slow', users.importer.id);
  await reattachProposal(t.pool, store, users.importer.id, id, now.id);
  expect((await listProposals(t.pool, store, users.importer.id, id))[0]).toMatchObject({
    status: 'open',
    stale: false,
    now: 'slow',
  });
});

test('the review data says which proposals were stale and which lost their place', async () => {
  const a = await lostPlace();
  const outA = await exportReview(t.pool, store, users.owner.id, a.id);
  expect(outA.proposals[0]).toMatchObject({ status: 'open', stale: true, placeLost: true });
  const c = await wordChanged(false);
  const outC = await exportReview(t.pool, store, users.owner.id, c.id);
  expect(outC.proposals[0]).toMatchObject({ status: 'open', stale: true });
  expect(outC.proposals[0]).not.toHaveProperty('placeLost');
});

test('an insertion whose place is intact still arrives fresh and can be accepted', async () => {
  const p = await paper();
  await propose(t.pool, store, users.reviewer.id, p.id, p.file, {
    ...(await caretAfter(p.file, 'below 40 ms')),
    replacement: ' (95th percentile)',
  });
  const { id } = await trip(p.id);
  const [now] = await listProposals(t.pool, store, users.importer.id, id);
  expect(now).toMatchObject({ status: 'open', stale: false });
  await acceptProposal(t.pool, store, users.importer.id, id, now.id);
  const [file] = await listFiles(t.pool, users.importer.id, id);
  expect(await saved(file.id)).toContain('below 40 ms (95th percentile) for most edits.');
});
