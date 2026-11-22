// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
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
// The limits count what this file's tests asked for; each test starts from none.
beforeEach(() => t.pool.query('delete from doi_requests'));
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
      headers: { accept: 'application/json', 'user-agent': 'PaperWeave/0.1' },
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
  expect(await removeEvidence(t.pool, users.reviewer.id, p.id, mine.id)).toEqual({
    key: 'knuth1984',
  });
  await removeEvidence(t.pool, users.owner.id, p.id, owners.id);
  expect((await citationChecks(t.pool, store, users.owner.id, p.id)).evidence).toEqual({});
});

// Entries as real bibliographies hold them, looked up against a stand-in registry.
async function paperOf(bib: string, main = 'Hello~\\cite{k}.') {
  const files = {
    'main.tex': `\\documentclass{article}\n\\begin{document}\n${main}\n\\bibliography{refs}\n\\end{document}\n`,
    'refs.bib': bib,
  };
  const zip = await writeZip(
    Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Lookup');
  return project.id as string;
}
/** Look up entry `k` of `bib`; the registry answers `record` (or a status), and the URLs asked are kept. */
async function lookup(bib: string, record: object | number) {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    return typeof record === 'number'
      ? new Response('{}', { status: record })
      : Response.json({ status: 'ok', message: record });
  };
  const result = await lookUpDoi(t.pool, store, users.owner.id, await paperOf(bib), 'k', {
    fetcher,
    registry: 'https://registry.test',
  });
  return { ...result, asked };
}
const entry = (fields: string) => `@article{k, doi={10.1000/x}, ${fields}}`;
const seen = (r: { comparison: { field: string; same: boolean }[] }) =>
  Object.fromEntries(r.comparison.map((c) => [c.field, c.same]));

test('1. a DOI is looked up as a person would read it, not as it was typed', async () => {
  const underscore = await lookup('@article{k, title={T}, doi = {10.1007/978-3-540-74958-5\\_1}}', {
    title: ['T'],
  });
  expect(underscore.asked).toEqual(['https://registry.test/works/10.1007%2F978-3-540-74958-5_1']);
  expect(underscore).toMatchObject({ doi: '10.1007/978-3-540-74958-5_1', outcome: 'matches' });
  for (const written of [
    'doi:10.1000/x',
    'DOI 10.1000/x',
    '10.1000/x.',
    'https://dx.doi.org/10.1000/x',
  ]) {
    const r = await lookup(`@article{k, title={T}, doi = {${written}}}`, { title: ['T'] });
    expect([written, r.asked, r.doi]).toEqual([
      written,
      ['https://registry.test/works/10.1000%2Fx'],
      '10.1000/x',
    ]);
  }
  const fromUrl = await lookup('@article{k, title={T}, url = {https://doi.org/10.1000/x}}', {
    title: ['T'],
  });
  expect(fromUrl).toMatchObject({ doi: '10.1000/x', outcome: 'matches' });
  expect(fromUrl.asked).toEqual(['https://registry.test/works/10.1000%2Fx']);
  // A URL that is not a DOI is no DOI.
  expect(
    await code(lookup('@article{k, title={T}, url = {https://example.org/10.1000/x}}', {})),
  ).toBe('invalid_input');
  // The cleaned DOI is the one stored.
  const p = await paperOf('@article{k, title={T}, doi = {doi:10.1000/x.}}');
  await lookUpDoi(t.pool, store, users.owner.id, p, 'k', {
    fetcher: async () => Response.json({ message: { title: ['T'] } }),
    registry: 'https://registry.test',
  });
  expect((await citationChecks(t.pool, store, users.owner.id, p)).lookups.k.doi).toBe('10.1000/x');
});

test('2. a Crossref 404 is still "not found"', async () => {
  const r = await lookup('@article{k, title={Attention}, doi={10.48550/arXiv.1706.03762}}', 404);
  expect(r).toMatchObject({ outcome: 'not_found', comparison: [] });
  expect(r.asked).toEqual(['https://registry.test/works/10.48550%2FarXiv.1706.03762']);
});

test('3. text in other scripts is compared, not squashed to nothing', async () => {
  const chinese = await lookup(entry('title={机器学习}'), { title: ['深度学习'] });
  expect(chinese.outcome).toBe('differs');
  expect(seen(chinese)).toEqual({ title: false });
  expect((await lookup(entry('title={机器学习}'), { title: ['机器学习'] })).outcome).toBe(
    'matches',
  );
  const russian = await lookup(entry('title={Квантовая механика}'), {
    title: ['Теория относительности'],
  });
  expect(russian.outcome).toBe('differs');
  expect(
    (await lookup(entry('title={Quantum mechanics}'), { title: ['Quantum Mechanics'] })).outcome,
  ).toBe('matches');
  expect(
    seen(
      await lookup(entry('title={T}, author={M{\\"u}ller, A.}'), {
        title: ['T'],
        author: [{ family: 'Müller' }],
      }),
    )['first author'],
  ).toBe(true);

  // A claim in Chinese is said only while it is in the paper.
  const p = await paperOf(entry('title={T}'), '机器学习改变了世界~\\cite{k}.');
  const claim = '机器学习改变了世界';
  await recordEvidence(t.pool, store, users.owner.id, p, 'k', { claim, verdict: 'supports' });
  await recordEvidence(t.pool, store, users.owner.id, p, 'k', {
    claim: '完全不同的句子',
    verdict: 'supports',
  });
  await recordEvidence(t.pool, store, users.owner.id, p, 'k', {
    claim: 'the method works well',
    verdict: 'supports',
  });
  const said = async () =>
    (await citationChecks(t.pool, store, users.owner.id, p)).evidence.k.map((c) => c.stillSaid);
  expect(await said()).toEqual([true, false, false]);
  const [main] = (await listFiles(t.pool, users.owner.id, p)).filter((f) => f.path === 'main.tex');
  await editFile(t.pool, store, main.id, users.owner.id, (text) => {
    const at = text.toString().indexOf(claim);
    text.delete(at, claim.length);
  });
  expect(await said()).toEqual([false, false, false]);
});

test('4. markup in the registry is not a difference', async () => {
  const coli = await lookup(entry('title={Growth of E. coli \\& others}'), {
    title: ['Growth of <i>E. coli</i> &amp; others'],
  });
  expect(coli.outcome).toBe('matches');
  expect(coli.comparison[0].registry).toBe('Growth of E. coli & others');
  const water = await lookup(entry('title={H$_2$O at high pressure}'), {
    title: ['H<sub>2</sub>O at high pressure'],
  });
  expect(water.outcome).toBe('matches');
  const refs = await lookup(entry('title={A &lt; B &#39;quoted&#39; &#x41;}'), {
    title: ['A &lt; B &#39;quoted&#39; &#x41;'],
  });
  expect(refs.comparison[0].registry).toBe("A < B 'quoted' A");
});

test('5. the first author is the same person however the entry writes the name', async () => {
  const author = async (name: string, registryAuthor: object) =>
    seen(
      await lookup(entry(`title={T}, author={${name}}`), {
        title: ['T'],
        author: [registryAuthor],
      }),
    )['first author'];
  const waals = { family: 'van der Waals', given: 'Johannes' };
  expect(await author('Johannes van der Waals', waals)).toBe(true);
  expect(await author('van der Waals, Johannes', waals)).toBe(true);
  expect(await author('Martin Luther King, Jr.', { family: 'King' })).toBe(true);
  expect(await author('King, Jr., Martin Luther', { family: 'King' })).toBe(true);
  expect(await author('{World Health Organization}', { name: 'World Health Organization' })).toBe(
    true,
  );
  expect(await author('M{\\"u}ller, A.', { family: 'Müller' })).toBe(true);
  expect(await author('Ørsted, H.', { family: 'Ørsted' })).toBe(true);
  expect(await author('Leslie Lamport', { family: 'Lamport' })).toBe(true);
  expect(await author('Johannes van der Waals', { family: 'Lamport' })).toBe(false);
  expect(await author('Martin Luther King, Jr.', { family: 'Luther' })).toBe(false);
  expect(await author('{World Health Organization}', { name: 'Red Cross' })).toBe(false);
});

test('6. a title and its subtitle may be given together or apart', async () => {
  const record = { title: ['Attention'], subtitle: ['all you need'] };
  const together = await lookup(entry('title={Attention: all you need}'), record);
  expect(together.outcome).toBe('matches');
  expect((await lookup(entry('title={Attention}'), record)).outcome).toBe('matches');
  expect((await lookup(entry('title={Something else}'), record)).outcome).toBe('differs');
});

test("7. the year may be any of the record's dates", async () => {
  const record = {
    title: ['T'],
    issued: { 'date-parts': [[2021]] },
    'published-print': { 'date-parts': [[2020]] },
    'published-online': { 'date-parts': [[2019]] },
  };
  for (const year of ['2021', '2020', '2019']) {
    const r = await lookup(entry(`title={T}, year={${year}}`), record);
    expect([year, r.outcome, r.comparison.find((c) => c.field === 'year')?.registry]).toEqual([
      year,
      'matches',
      year,
    ]);
  }
  const wrong = await lookup(entry('title={T}, year={2000}'), record);
  expect(wrong.comparison.find((c) => c.field === 'year')).toEqual({
    field: 'year',
    entry: '2000',
    registry: '2021',
    same: false,
  });
});

test('8. the venue may be the full or the short title', async () => {
  const record = {
    title: ['T'],
    'container-title': ['Physical Review Letters'],
    'short-container-title': ['Phys. Rev. Lett.'],
  };
  expect((await lookup(entry('title={T}, journal={Phys. Rev. Lett.}'), record)).outcome).toBe(
    'matches',
  );
  expect(
    (await lookup(entry('title={T}, journal={Physical Review Letters}'), record)).outcome,
  ).toBe('matches');
  expect((await lookup(entry('title={T}, journal={Nature}'), record)).outcome).toBe('differs');
});

test('9. a claim copied from the PDF is still said while the sentence stands', async () => {
  const p = await paperOf(
    entry('title={T}'),
    [
      'As shown in prior work~\\cite{k}, the method works well.',
      'See Figure~\\ref{f} for the first example, an exam-\nple of caching.',
      'The cache grew by 15 percent.',
    ].join('\n'),
  );
  const claims = [
    'As shown in prior work [3], the method works well.',
    'As shown in prior work [3, 4], the method works well.',
    'As shown in prior work [3–5], the method works well.',
    'See Figure 2 for the first example',
    'See Figure 2 for the ﬁrst example',
    'an example of caching',
    // A changed quantity is a changed claim.
    'The cache grew by 20 percent.',
    'The cache grew by 15 percent.',
    'See Figure 2 for another example',
  ];
  for (const claim of claims)
    await recordEvidence(t.pool, store, users.owner.id, p, 'k', { claim, verdict: 'supports' });
  const result = (await citationChecks(t.pool, store, users.owner.id, p)).evidence.k;
  expect(result.map((c) => [c.claim, c.stillSaid])).toEqual(
    claims.map((c) => [c, !/20 percent|another/.test(c)]),
  );
});

test('DOI lookups are limited for each person and each paper, and a refusal asks nothing', async () => {
  const p = await paper();
  const r = registry();
  const look = (who: string, opts = {}) =>
    lookUpDoi(t.pool, store, who, p.id, 'knuth1984', { ...r, ...opts });
  for (let i = 0; i < 30; i++) await look(users.owner.id);
  const before = r.asked.length;
  const refused = await look(users.owner.id).catch((e) => e);
  expect(refused.code).toBe('conflict');
  expect(refused.message).toBe('Too many DOI lookups just now. Try again in a few minutes.');
  expect(r.asked.length).toBe(before);
  // Someone else is not held back by it.
  await look(users.reviewer.id);
  expect(r.asked.length).toBe(before + 1);
  // A person who may not look is told so before the limit is looked at.
  expect(await code(look(users.viewer.id))).toBe('permission_denied');
  // The paper's own cap, however many people ask.
  expect(await code(look(users.reviewer.id, { perProject: 31 }))).toBe('conflict');
  expect(await code(look(users.reviewer.id, { perProject: 32 }))).not.toBe('conflict');
});

test('the contact address is sent only when an operator has set one', async () => {
  const p = await paper();
  const r = registry();
  const agent = () => (r.asked.at(-1)?.headers as Record<string, string>)['user-agent'];
  vi.stubEnv('CROSSREF_MAILTO', '');
  await lookUpDoi(t.pool, store, users.owner.id, p.id, 'knuth1984', r);
  expect(agent()).toBe('PaperWeave/0.1');
  vi.stubEnv('CROSSREF_MAILTO', 'ops@example.test');
  try {
    await lookUpDoi(t.pool, store, users.owner.id, p.id, 'knuth1984', r);
    expect(agent()).toBe('PaperWeave/0.1 (mailto:ops@example.test)');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('an answer over 1 MB is not read, and a redirect is not followed', async () => {
  const p = await paper();
  const base = { registry: 'https://registry.test' };
  const go = (fetcher: (u: string, i: RequestInit) => Promise<Response>) =>
    code(lookUpDoi(t.pool, store, users.owner.id, p.id, 'knuth1984', { ...base, fetcher }));
  const parse = vi.spyOn(JSON, 'parse');
  const big = new Uint8Array(2_000_000).fill(32);
  expect(await go(async () => new Response(big, { status: 200 }))).toBe('unavailable');
  // No length is promised: the body is cut off as it arrives.
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(500_000).fill(32));
      c.close();
    },
  });
  expect(await go(async () => new Response(stream, { status: 200 }))).toBe('unavailable');
  expect(parse).not.toHaveBeenCalled();
  parse.mockRestore();
  let init: RequestInit | undefined;
  const sent = await go(async (_u, i) => {
    init = i;
    return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
  });
  expect(sent).toBe('unavailable');
  expect(init?.redirect).toBe('manual');
});
