// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { citationChecks, lookUpDoi, recordEvidence, removeEvidence } from './evidence.ts';
import { importZip, listFiles } from './import.ts';
import { acceptInvitation, invite } from './projects.ts';
import { editFile } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
const users = {} as Record<
  'owner' | 'reviewer' | 'second' | 'viewer' | 'outsider',
  { id: string; email: string }
>;

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'reviewer', 'second', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
});
afterAll(() => t.close());

const FILES = {
  'main.tex': [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\emph{Literate programming} treats a program as a work of\n  literature~\\cite{knuth1984}.',
    'LaTeX was first released in 1984~\\cite{lamport1994}.',
    '\\bibliography{refs}',
    '\\end{document}',
    '',
  ].join('\n'),
  'refs.bib': [
    '@article{knuth1984,',
    '  author = {Knuth, Donald E.},',
    '  title = {Literate {P}rogramming},',
    '  journal = {The Computer Journal},',
    '  year = {1984},',
    '  doi = {https://doi.org/10.1093/comjnl/27.2.97}',
    '}',
    '@book{lamport1994, author = {Leslie Lamport}, title = {LaTeX: A Document Preparation System}, year = {1993}, doi = {10.5555/lamport}}',
    '@misc{nodoi, title = {No DOI here}}',
    '@misc{gone, title = {Withdrawn}, doi = {10.1234/gone}}',
    '',
  ].join('\n'),
};
async function paper() {
  const zip = await writeZip(
    Object.entries(FILES).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Evidence');
  for (const [who, role] of [
    ['reviewer', 'reviewer'],
    ['second', 'reviewer'],
    ['viewer', 'viewer'],
  ] as const) {
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, role);
    await acceptInvitation(t.pool, users[who].id, token);
  }
  const ids = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  return { id: project.id, ids };
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

/** A stand-in for the registry: it answers from a table and remembers what it was asked. */
function registry() {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const records: Record<string, object | number> = {
    '10.1093/comjnl/27.2.97': {
      title: ['Literate Programming'],
      author: [{ family: 'Knuth', given: 'D. E.' }],
      issued: { 'date-parts': [[1984, 5, 1]] },
      'container-title': ['The Computer Journal'],
    },
    '10.5555/lamport': {
      title: ['LaTeX: a document preparation system'],
      author: [{ family: 'Lamport', given: 'Leslie' }],
      issued: { 'date-parts': [[1994]] },
    },
    '10.1234/gone': 404,
  };
  const fetcher = async (url: string, init: RequestInit) => {
    asked.push({ url, headers: init.headers as Record<string, string> });
    const record = records[decodeURIComponent(url.slice(url.indexOf('/works/') + 7))];
    if (typeof record === 'number' || !record) return new Response('{}', { status: record ?? 500 });
    return Response.json({ status: 'ok', message: record });
  };
  return { asked, fetcher, registry: 'https://registry.test' };
}

test('a DOI lookup records what the registry said, where it came from and when', async () => {
  const p = await paper();
  const r = registry();
  const look = (who: string, key: string) => lookUpDoi(t.pool, store, who, p.id, key, r);

  const knuth = await look(users.reviewer.id, 'knuth1984');
  expect(knuth).toMatchObject({
    outcome: 'matches',
    source: 'crossref',
    doi: '10.1093/comjnl/27.2.97',
  });
  expect(knuth.comparison.map((c) => [c.field, c.same])).toEqual([
    ['title', true],
    ['year', true],
    ['first author', true],
    ['venue', true],
  ]);
  // Only the DOI went out: no paper, no person.
  expect(r.asked).toEqual([
    {
      url: 'https://registry.test/works/10.1093%2Fcomjnl%2F27.2.97',
      headers: { accept: 'application/json', 'user-agent': 'PaperWeave (DOI lookup)' },
    },
  ]);

  // A difference is reported with both sides. Capital letters and braces are not a difference.
  const lamport = await look(users.owner.id, 'lamport1994');
  expect(lamport.outcome).toBe('differs');
  expect(lamport.comparison).toEqual([
    {
      field: 'title',
      entry: 'LaTeX: A Document Preparation System',
      registry: 'LaTeX: a document preparation system',
      same: true,
    },
    { field: 'year', entry: '1993', registry: '1994', same: false },
    { field: 'first author', entry: 'Lamport', registry: 'Lamport', same: true },
  ]);
  expect((await look(users.owner.id, 'gone')).outcome).toBe('not_found');

  // Nothing to look up, nobody to ask, or not allowed: nothing is recorded.
  expect(await code(look(users.owner.id, 'nodoi'))).toBe('invalid_input');
  expect(await code(look(users.owner.id, 'nosuchkey'))).toBe('invalid_input');
  expect(await code(look(users.viewer.id, 'knuth1984'))).toBe('permission_denied');
  expect(await code(look(users.outsider.id, 'knuth1984'))).toBe('not_found');
  const down = { ...r, fetcher: () => Promise.reject(new Error('no network')) };
  expect(await code(lookUpDoi(t.pool, store, users.owner.id, p.id, 'knuth1984', down))).toBe(
    'unavailable',
  );
  const broken = { ...r, fetcher: async () => new Response('oops', { status: 502 }) };
  expect(await code(lookUpDoi(t.pool, store, users.owner.id, p.id, 'knuth1984', broken))).toBe(
    'unavailable',
  );

  const { lookups, evidence } = await citationChecks(t.pool, store, users.viewer.id, p.id);
  expect(Object.keys(lookups).sort()).toEqual(['gone', 'knuth1984', 'lamport1994']);
  expect(lookups.knuth1984).toMatchObject({
    outcome: 'matches',
    lookedUpBy: 'reviewer@example.org',
    outOfDate: false,
  });
  expect(Date.now() - new Date(lookups.knuth1984.lookedUpAt).getTime()).toBeLessThan(60_000);
  // Looking an entry up says nothing about whether it supports any claim.
  expect(evidence).toEqual({});

  // The entry is corrected: the old lookup is about what it used to say.
  await editFile(t.pool, store, p.ids['refs.bib'], users.owner.id, (text) => {
    const at = text.toString().indexOf('1993');
    text.delete(at, 4);
    text.insert(at, '1994');
  });
  const after = await citationChecks(t.pool, store, users.owner.id, p.id);
  expect(after.lookups.lamport1994).toMatchObject({ outcome: 'differs', outOfDate: true });
  expect(after.lookups.knuth1984.outOfDate).toBe(false);
  expect((await look(users.owner.id, 'lamport1994')).outcome).toBe('matches');
  const again = await citationChecks(t.pool, store, users.owner.id, p.id);
  expect(again.lookups.lamport1994).toMatchObject({ outcome: 'matches', outOfDate: false });
});

test('an evidence check is about one quoted claim, and is kept apart from the entry being right', async () => {
  const p = await paper();
  const record = (who: string, key: string, check: object) =>
    recordEvidence(t.pool, store, who, p.id, key, check as never);
  // Quoted as it reads on the page: no markup, one line.
  const claim = 'Literate programming treats a program as a work of literature';
  await record(users.reviewer.id, 'knuth1984', { claim, verdict: 'supports', note: 'Section 1.' });
  await record(users.owner.id, 'lamport1994', {
    claim: 'LaTeX was first released in 1984',
    verdict: 'does_not_support',
  });

  for (const bad of [
    { claim: '', verdict: 'supports' },
    { claim, verdict: 'probably' },
    { claim: 'x'.repeat(2001), verdict: 'supports' },
    { claim, verdict: 'supports', note: 'y'.repeat(2001) },
    { verdict: 'supports' },
  ])
    expect(await code(record(users.owner.id, 'knuth1984', bad))).toBe('invalid_input');
  expect(await code(record(users.owner.id, 'nosuchkey', { claim, verdict: 'supports' }))).toBe(
    'invalid_input',
  );
  expect(await code(record(users.viewer.id, 'knuth1984', { claim, verdict: 'supports' }))).toBe(
    'permission_denied',
  );
  expect(await code(record(users.outsider.id, 'knuth1984', { claim, verdict: 'supports' }))).toBe(
    'not_found',
  );

  const seen = await citationChecks(t.pool, store, users.second.id, p.id);
  expect(seen.lookups).toEqual({});
  expect(seen.evidence.knuth1984).toEqual([
    {
      id: expect.any(String),
      key: 'knuth1984',
      claim,
      verdict: 'supports',
      note: 'Section 1.',
      checkedBy: 'reviewer@example.org',
      checkedAt: expect.any(String),
      // Found in the paper although the source has \emph{...}, a line break and a tie.
      stillSaid: true,
      // Another reviewer's check is not this reviewer's to remove.
      mine: false,
    },
  ]);
  expect(seen.evidence.lamport1994[0]).toMatchObject({ verdict: 'does_not_support', note: null });

  // The sentence is rewritten: the check stays, marked as about words no longer in the paper.
  await editFile(t.pool, store, p.ids['main.tex'], users.owner.id, (text) => {
    const at = text.toString().indexOf('a work of');
    text.delete(at, 'a work of'.length);
    text.insert(at, 'a piece of');
  });
  const later = await citationChecks(t.pool, store, users.reviewer.id, p.id);
  expect(later.evidence.knuth1984[0]).toMatchObject({ stillSaid: false, mine: true });
  expect(later.evidence.lamport1994[0]).toMatchObject({ stillSaid: true, mine: false });

  // Its author may remove it, and so may someone who can edit the paper. Nobody else.
  const [mine] = later.evidence.knuth1984;
  const [owners] = later.evidence.lamport1994;
  expect(await code(removeEvidence(t.pool, users.second.id, p.id, mine.id))).toBe('not_found');
  expect(await code(removeEvidence(t.pool, users.viewer.id, p.id, mine.id))).toBe(
    'permission_denied',
  );
  expect(await code(removeEvidence(t.pool, users.reviewer.id, p.id, owners.id))).toBe('not_found');
  await removeEvidence(t.pool, users.reviewer.id, p.id, mine.id);
  await removeEvidence(t.pool, users.owner.id, p.id, owners.id);
  expect((await citationChecks(t.pool, store, users.owner.id, p.id)).evidence).toEqual({});
});
