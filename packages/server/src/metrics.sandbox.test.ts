// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { productMetrics, recordGrammarOutcome } from './metrics.ts';
import { acceptInvitation, createProject, invite } from './projects.ts';
import { acceptProposal, closeProposal, propose } from './proposals.ts';
import { compactFile, editFile, loadUpdates, TEXT } from './sync.ts';
import { createFromTemplate } from './templates.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let editor: { id: string; email: string };

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  editor = await t.signIn('editor@example.org');
});
afterAll(() => t.close());

const MAIN = '\\documentclass{article}\n\\begin{document}\nA secret sentence.\n\\end{document}\n';

test('how papers fare is counted, by how they began, and says nothing of what they hold', async () => {
  expect(await productMetrics(t.pool)).toEqual({
    papers: [],
    edited: 0,
    twoAuthors: 0,
    proposals: [],
    grammar: [],
  });

  await createProject(t.pool, owner.id, 'Empty');
  await createFromTemplate(t.pool, store, owner.id, 'From a template', 'ieee');
  const article = await createFromTemplate(t.pool, store, owner.id, 'Another', 'article');
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  const [imported] = await importZip(t.pool, store, owner.id, zip, 'Imported');
  const [alone] = await importZip(t.pool, store, owner.id, zip, 'Imported too');
  const { token } = await invite(t.pool, owner.id, imported.id, editor.email, 'editor');
  await acceptInvitation(t.pool, editor.id, token);
  const file = async (project: string) => (await listFiles(t.pool, owner.id, project))[0].id;
  const type = (fileId: string, who: string, words: string) =>
    editFile(t.pool, store, fileId, who, (text) => text.insert(0, words));

  // Two people write one paper, one person another. Two papers are downloaded, one twice.
  const shared = await file(imported.id);
  await type(shared, owner.id, '% one\n');
  await type(shared, editor.id, '% two\n');
  await type(await file(alone.id), owner.id, '% mine\n');
  await exportZip(t.pool, store, owner.id, imported.id);
  await exportZip(t.pool, store, owner.id, imported.id);
  await exportZip(t.pool, store, owner.id, article.id);

  // Three proposals: one taken, one turned down, one left open.
  const ends = async (words: string) => {
    const doc = new Y.Doc();
    for (const u of await loadUpdates(t.pool, store, shared)) Y.applyUpdate(doc, u);
    const text = doc.getText(TEXT);
    const at = text.toString().indexOf(words);
    const rel = (i: number, side: number) =>
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, i, side));
    return { from: rel(at, 0), to: rel(at + words.length, -1) };
  };
  const make = async (words: string, replacement: string) =>
    propose(t.pool, store, editor.id, imported.id, shared, { ...(await ends(words)), replacement });
  await acceptProposal(t.pool, store, owner.id, imported.id, await make('secret', 'plain'));
  await closeProposal(t.pool, owner.id, imported.id, await make('sentence', 'line'), 'rejected');
  const open = await make('A ', 'One ');
  await t.pool.query("update proposals set origin = 'critique' where id = $1", [open]);

  const want = {
    papers: [
      { origin: 'article', papers: 1, downloadedZip: 1, downloadedPdf: 0 },
      { origin: 'empty', papers: 1, downloadedZip: 0, downloadedPdf: 0 },
      { origin: 'ieee', papers: 1, downloadedZip: 0, downloadedPdf: 0 },
      { origin: 'imported', papers: 2, downloadedZip: 1, downloadedPdf: 0 },
    ],
    edited: 2,
    twoAuthors: 1,
    proposals: [
      { origin: 'critique', status: 'open', count: 1 },
      { origin: 'person', status: 'accepted', count: 1 },
      { origin: 'person', status: 'rejected', count: 1 },
    ],
    grammar: [
      { kind: 'grammar', outcome: 'rule_off', count: 1 },
      { kind: 'spelling', outcome: 'changed', count: 2 },
      { kind: 'spelling', outcome: 'proposed', count: 1 },
      { kind: 'spelling', outcome: 'word', count: 1 },
    ],
  };
  // Findings taken up, summed across papers; the words and the rule are never stored.
  const grammar = (who: string, project: string, kind: string, outcome: string) =>
    recordGrammarOutcome(t.pool, who, project, kind, outcome);
  await grammar(owner.id, imported.id, 'spelling', 'changed');
  await grammar(editor.id, imported.id, 'spelling', 'changed');
  await grammar(owner.id, alone.id, 'spelling', 'word');
  await grammar(owner.id, alone.id, 'grammar', 'rule_off');
  await grammar(editor.id, imported.id, 'spelling', 'proposed');
  expect(await productMetrics(t.pool)).toEqual(want);
  // Compacting a file's log forgets who wrote each edit, but not that two people wrote here.
  expect(await compactFile(t.pool, shared)).toBeGreaterThan(0);
  expect(
    (await t.pool.query('select count(*)::int as n from file_updates where file_id = $1', [shared]))
      .rows[0].n,
  ).toBe(1);
  expect(await productMetrics(t.pool)).toEqual(want);
  // Counts and names of templates and states: nothing of any paper.
  expect(JSON.stringify(await productMetrics(t.pool))).not.toMatch(/secret|sentence|Imported/);
});

test('a finding of the grammar checker is counted by kind and outcome, and no other way', async () => {
  const { id } = await createProject(t.pool, owner.id, 'Counted');
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e) => e.code,
    );
  const before = (await productMetrics(t.pool)).grammar;
  expect(await code(recordGrammarOutcome(t.pool, owner.id, id, 'style', 'changed'))).toBe('ok');
  expect(await code(recordGrammarOutcome(t.pool, owner.id, id, 'style', 'changed'))).toBe('ok');
  const row = (await t.pool.query('select * from grammar_outcomes where project_id = $1', [id]))
    .rows;
  expect(row).toEqual([{ project_id: id, kind: 'style', outcome: 'changed', count: 2 }]);
  expect((await productMetrics(t.pool)).grammar).not.toEqual(before);
  for (const [kind, outcome] of [
    ['typo', 'changed'],
    ['style', 'ignored'],
    [undefined, 'changed'],
    ['style', { $ne: 1 }],
  ])
    expect(await code(recordGrammarOutcome(t.pool, owner.id, id, kind, outcome))).toBe(
      'invalid_input',
    );
  expect(
    (
      await t.pool.query(
        'select sum(count)::int as n from grammar_outcomes where project_id = $1',
        [id],
      )
    ).rows[0].n,
  ).toBe(2);
});
