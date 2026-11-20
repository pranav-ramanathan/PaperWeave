// Inside one request, a paper's files and a person's place in the paper are read once.
import * as Y from 'yjs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { writeZip } from './archive.ts';
import { authorize } from './authz.ts';
import { blobStore } from './blobs.ts';
import { citationChecks } from './evidence.ts';
import { citationReport } from './citations.ts';
import { listCharts } from './charts.ts';
import { listDatasets } from './data.ts';
import { importReport, importZip, listFiles } from './import.ts';
import { labelReport, texFiles } from './labels.ts';
import { acceptInvitation, firstSteps, getProject, invite, listMembers } from './projects.ts';
import { modelProcessing } from './projects.ts';
import { languageSettings } from './grammar.ts';
import { listProposals, propose } from './proposals.ts';
import { heldInRevisions, heldNow, listRevisions, olderAutoRevisions } from './revisions.ts';
import { withScope } from './scope.ts';
import { heldDataReadBy, submissionChecks } from './submit.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
import { listThreads, startThread } from './threads.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let viewer: { id: string; email: string };
let outsider: { id: string };
let project: string;
let paths: Record<string, string>;
const FILES = 30;

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  viewer = await t.signIn('viewer@example.org');
  outsider = await t.signIn('outsider@example.org');
  const sections = Array.from({ length: FILES - 1 }, (_, i) => `sections/s${i}`);
  const zip = await writeZip(
    Object.entries({
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        ...sections.map((s) => `\\input{${s}}`),
        'See \\ref{sec:s0} and \\cite{k0}.',
        '\\bibliography{refs}',
        '\\end{document}',
        '',
      ].join('\n'),
      'refs.bib': '@article{k0, title={A}, author={B}, year={2020}}\n',
      ...Object.fromEntries(
        sections.map((s, i) => [
          `${s}.tex`,
          `\\section{S${i}}\\label{sec:s${i}}\nSome words here.\n`,
        ]),
      ),
    }).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  [{ id: project }] = await importZip(t.pool, store, owner.id, zip, 'Scope');
  const { token } = await invite(t.pool, owner.id, project, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  const files = await listFiles(t.pool, owner.id, project);
  paths = Object.fromEntries(files.map((f) => [f.path, f.id]));
  // Every .tex file is edited, so each has a log of more than the upload.
  for (const f of files.filter((f) => f.path.endsWith('.tex')))
    await editFile(t.pool, store, f.id, owner.id, (text) => text.insert(0, '% edited\n'));
  // A thread and a proposal on a few files.
  for (const name of ['sections/s1.tex', 'sections/s2.tex', 'main.tex']) {
    const doc = new Y.Doc();
    for (const u of await loadUpdates(t.pool, store, paths[name])) Y.applyUpdate(doc, u);
    const text = doc.getText(TEXT);
    const at = text.toString().indexOf('Some words');
    const place = {
      from: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, 0)),
      to: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at + 4, -1)),
    };
    if (at < 0) continue;
    await startThread(t.pool, store, owner.id, project, paths[name], { ...place, body: 'Hm.' });
    await propose(t.pool, store, owner.id, project, paths[name], { ...place, replacement: 'Few' });
  }
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

/** What the paper's page reads, all at once as it does. */
async function pageReads() {
  const db = t.pool;
  const revisions = await listRevisions(db, owner.id, project, { autos: 10 });
  await Promise.all([
    getProject(db, owner.id, project),
    listMembers(db, owner.id, project),
    listFiles(db, owner.id, project),
    importReport(db, owner.id, project),
    labelReport(db, store, owner.id, project),
    citationReport(db, store, owner.id, project),
    citationChecks(db, store, owner.id, project),
    listDatasets(db, store, owner.id, project),
    listCharts(db, store, owner.id, project),
    listThreads(db, store, owner.id, project),
    listProposals(db, store, owner.id, project),
    languageSettings(db, owner.id, project),
    modelProcessing(db, owner.id, project),
    firstSteps(db, owner.id, project),
    heldNow(db, owner.id, project),
    heldDataReadBy(db, store, owner.id, project),
    heldInRevisions(
      db,
      owner.id,
      project,
      revisions.map((r) => r.id),
    ),
    olderAutoRevisions(db, owner.id, project, 1),
  ]);
}

test('a paper of edited files is read in few statements inside a scope', async () => {
  const { statements } = await counting(() => withScope(pageReads));
  // Without a scope the same reads take about 180: each file's log is read again by each report.
  expect(statements).toBeLessThan(40);
});

test('the checks before submitting read the paper once as well', async () => {
  const { statements, result } = await counting(() =>
    submissionChecks(t.pool, store, owner.id, project),
  );
  expect(result.findings).toBeDefined();
  expect(statements).toBeLessThan(25);
});

test('what a scope remembers is who is in the paper, not what they may do', async () => {
  await withScope(async () => {
    const { statements } = await counting(async () => {
      expect(await authorize(t.pool, viewer.id, project, 'project.read')).toBe('viewer');
      await expect(authorize(t.pool, viewer.id, project, 'file.write')).rejects.toMatchObject({
        code: 'permission_denied',
      });
      await expect(authorize(t.pool, viewer.id, project, 'members.manage')).rejects.toMatchObject({
        code: 'permission_denied',
      });
      expect(await authorize(t.pool, viewer.id, project, 'project.read')).toBe('viewer');
    });
    // The role was asked for once, and every action was still judged.
    expect(statements).toBe(1);
    // The owner, in the same scope, is not taken for the viewer.
    expect(await authorize(t.pool, owner.id, project, 'members.manage')).toBe('owner');
  });
  // A stranger is not found, and being found out twice costs one statement.
  await withScope(async () => {
    const { statements } = await counting(async () => {
      for (let i = 0; i < 2; i++)
        await expect(authorize(t.pool, outsider.id, project, 'project.read')).rejects.toMatchObject(
          { code: 'not_found' },
        );
    });
    expect(statements).toBe(1);
  });
  // Outside a scope every ask is a statement.
  const { statements } = await counting(async () => {
    await authorize(t.pool, viewer.id, project, 'project.read');
    await authorize(t.pool, viewer.id, project, 'project.read');
  });
  expect(statements).toBe(2);
});

test('a transaction and a lock are never answered from memory', async () => {
  await withScope(async () => {
    const before = (await texFiles(t.pool, store, project)).find((f) => f.path === 'main.tex')!;
    // Asked again, the pool is answered from memory.
    expect((await counting(() => texFiles(t.pool, store, project))).statements).toBe(0);
    await editFile(t.pool, store, paths['main.tex'], owner.id, (text) =>
      text.insert(0, '% again\n'),
    );
    // Asked to hold the files, it reads them as they are now.
    const locked = await t.pool.connect();
    try {
      await locked.query('begin');
      const now = (await texFiles(locked, store, project, true)).find(
        (f) => f.path === 'main.tex',
      )!;
      expect(now.text).toBe('% again\n' + before.text);
      await locked.query('rollback');
    } finally {
      locked.release();
    }
    // And so does the pool when it is asked to lock (outside a transaction, a lock ends at once).
    const pooled = (await texFiles(t.pool, store, project, true)).find(
      (f) => f.path === 'main.tex',
    )!;
    expect(pooled.text).toBe('% again\n' + before.text);
  });
});

test('two scopes share nothing: an edit between them is seen', async () => {
  const text = async () =>
    (await texFiles(t.pool, store, project)).find((f) => f.path === 'sections/s3.tex')!.text;
  const first = await withScope(async () => {
    const a = await text();
    expect((await counting(text)).statements).toBe(0);
    return a;
  });
  await editFile(t.pool, store, paths['sections/s3.tex'], owner.id, (y) => y.insert(0, '% new\n'));
  const second = await withScope(text);
  expect(second).toBe('% new\n' + first);
  // The threads follow the same edit.
  const before = await withScope(() => listThreads(t.pool, store, owner.id, project));
  const after = await withScope(() => listThreads(t.pool, store, owner.id, project));
  expect(after).toEqual(before);
});

test('what is read in a scope is what is read outside it', async () => {
  const plain = await texFiles(t.pool, store, project);
  const scoped = await withScope(() => texFiles(t.pool, store, project));
  expect(scoped).toEqual(plain);
  const threads = await listThreads(t.pool, store, owner.id, project);
  expect(await withScope(() => listThreads(t.pool, store, owner.id, project))).toEqual(threads);
  const proposals = await listProposals(t.pool, store, owner.id, project);
  expect(await withScope(() => listProposals(t.pool, store, owner.id, project))).toEqual(proposals);
});
