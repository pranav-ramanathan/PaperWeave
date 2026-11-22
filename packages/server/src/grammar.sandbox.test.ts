// Needs the services in infra/compose.yaml, the grammar checker among them. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { checkGrammar, languageSettings, setLanguageSettings } from './grammar.ts';
import { importZip, listFiles } from './import.ts';
import { recordGrammarOutcome } from './metrics.ts';
import { acceptInvitation, invite } from './projects.ts';
import { loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
const url = TEST_ENV.GRAMMAR_URL;
let t: Awaited<ReturnType<typeof testDb>>;
const users = {} as Record<
  'owner' | 'reviewer' | 'viewer' | 'outsider',
  { id: string; email: string }
>;

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'reviewer', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
});
afterAll(() => t.close());

// Mistakes in the prose, and the same mistakes where a checker must not look: in code, a
// citation key, a label, a formula, a unit, an address and a listing.
const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{siunitx}',
  '\\begin{document}',
  '\\section{Results}',
  'This are a sentense about the the latency of \\texttt{teh servr}, see \\cite{recieve2020}',
  'and Figure~\\ref{fig:teh}. It took \\SI{40}{msec} for $teh + recieve$ to settle.',
  '',
  'We analyse the colour of the plot at \\url{http://example.org/teh/recieve}.',
  'Our system, Weavely, is fast.',
  '\\begin{verbatim}',
  'teh recieve',
  '\\end{verbatim}',
  '\\end{document}',
  '',
].join('\n');
async function paper(main = MAIN) {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(main) },
    { path: 'notes.txt', bytes: Buffer.from('teh recieve\n') },
  ]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Grammar');
  for (const who of ['reviewer', 'viewer'] as const) {
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, who);
    await acceptInvitation(t.pool, users[who].id, token);
  }
  const ids = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  return { id: project.id, file: ids['main.tex'], notes: ids['notes.txt'] };
}
const check = (p: { id: string; file: string }, who: keyof typeof users = 'viewer') =>
  checkGrammar(t.pool, store, users[who].id, p.id, p.file, { url });
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test('mistakes in the prose are found, and nothing is found in what is not prose', async () => {
  const p = await paper();
  const found = await check(p);
  const words = found.map((f) => f.words);
  // The three kinds of mistake in the first sentence.
  expect(words).toEqual(expect.arrayContaining(['sentense', 'the the']));
  expect(found.find((f) => f.words === 'sentense')).toMatchObject({
    kind: 'spelling',
    replacements: expect.arrayContaining(['sentence']),
  });
  expect(found.some((f) => f.kind === 'grammar' && ['This', 'are'].includes(f.words))).toBe(true);
  // The same misspellings in code, a key, a label, a unit, a formula, an address and a
  // listing are not prose. No finding holds any of them.
  for (const f of found) expect(f.words).not.toMatch(/teh|recieve|servr|msec/);
  // A name the checker cannot know is a spelling finding until the paper says it is a word.
  expect(words).toContain('Weavely');
  // British spelling is the default: "analyse" and "colour" are right.
  expect(words).not.toContain('analyse');
  expect(words).not.toContain('colour');

  // Each finding says where it is, in positions that follow the text.
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, p.file)) Y.applyUpdate(doc, u);
  const text = doc.getText(TEXT);
  for (const f of found) {
    const at = (b64: string) =>
      Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(Buffer.from(b64, 'base64')),
        doc,
      )!.index;
    expect(text.toString().slice(at(f.from), at(f.to))).toBe(f.words);
    expect(f.rule).toMatch(/^[A-Z0-9_]+$/);
  }
});

test('nothing is found inside a citation, however it is written', async () => {
  const p = await paper(
    [
      '\\documentclass{article}',
      '\\begin{document}',
      'We agree \\autocites[see][12]{a}[adn recieve][15]{b} on this,',
      'and \\cite [teh servr] {k} with \\cite<adn recieve>{k} too.',
      '\\end{document}',
      '',
    ].join('\n'),
  );
  for (const f of await check(p)) expect(f.words).not.toMatch(/adn|teh|servr|recieve/);
});

test('a paper chooses its spelling, its own words and the rules it does without', async () => {
  const p = await paper();
  expect(await languageSettings(t.pool, users.viewer.id, p.id)).toEqual({
    language: 'en-GB',
    glossary: [],
    off: [],
  });
  const repeat = (await check(p)).find((f) => f.words === 'the the')!.rule;
  await setLanguageSettings(t.pool, users.owner.id, p.id, {
    language: 'en-US',
    glossary: [' Weavely ', 'Weavely', 'servr'],
    off: [repeat],
  });
  expect(await languageSettings(t.pool, users.viewer.id, p.id)).toEqual({
    language: 'en-US',
    glossary: ['servr', 'Weavely'],
    off: [repeat],
  });
  const words = (await check(p)).map((f) => f.words);
  // American spelling now, the paper's own word known, the repeated-word rule off.
  expect(words).toEqual(expect.arrayContaining(['analyse', 'colour', 'sentense']));
  expect(words).not.toContain('Weavely');
  expect(words).not.toContain('the the');
  // Only what is given changes.
  await setLanguageSettings(t.pool, users.owner.id, p.id, { language: 'en-GB' });
  expect(await languageSettings(t.pool, users.owner.id, p.id)).toMatchObject({
    language: 'en-GB',
    glossary: ['servr', 'Weavely'],
  });

  const set = (who: keyof typeof users, input: object) =>
    code(setLanguageSettings(t.pool, users[who].id, p.id, input));
  expect(await set('reviewer', { language: 'en-US' })).toBe('permission_denied');
  expect(await set('viewer', { glossary: ['x'] })).toBe('permission_denied');
  expect(await set('outsider', { language: 'en-US' })).toBe('not_found');
  expect(await set('owner', { language: 'fr' })).toBe('invalid_input');
  expect(await set('owner', { glossary: 'Weavely' })).toBe('invalid_input');
  expect(await set('owner', { glossary: ['two words'] })).toBe('invalid_input');
  expect(await set('owner', { off: ['not a rule; drop table'] })).toBe('invalid_input');
});

test('checking keeps to the paper, to LaTeX files, and says when no checker answers', async () => {
  const p = await paper();
  const other = await paper();
  expect(await code(check(p, 'outsider'))).toBe('not_found');
  expect(await code(check({ id: p.id, file: other.file }, 'owner'))).toBe('not_found');
  expect(await code(check({ id: p.id, file: p.notes }, 'owner'))).toBe('not_found');
  // Nothing listens there. (Asked with a rule off, so that it is a question not yet answered:
  // answers already given are kept.)
  await setLanguageSettings(t.pool, users.owner.id, other.id, {
    off: ['UPPERCASE_SENTENCE_START'],
  });
  expect(
    await code(
      checkGrammar(t.pool, store, users.owner.id, other.id, other.file, {
        url: 'http://127.0.0.1:9',
      }),
    ),
  ).toBe('unavailable');
});

const wrap = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

test('a replacement comes back as LaTeX source, and a word that is not a glossary word is said so', async () => {
  // The real checker offers "R&D" for a repeated R\&D. Written into the source as it is, that
  // is a bare & and the build breaks.
  const p = await paper(wrap('We fund R\\&D R\\&D every year, and a sentense.'));
  const found = await check(p, 'owner');
  const repeat = found.find((f) => f.rule === 'ENGLISH_WORD_REPEAT_RULE');
  expect(repeat).toMatchObject({ words: 'R\\&D R\\&D', replacements: ['R\\&D'] });
  // A plain word can be one of the paper's own; R\&D cannot, for the glossary does not take \ or &.
  expect(found.find((f) => f.words === 'sentense')?.addable).toBe(true);
  expect(repeat?.addable).toBe(false);

  // A checker that suggests a % or an &, which the real one does not do on this text.
  const q = await paper(wrap('We spent half of the R\\&D budget, a sentense here.'));
  const src = wrap('We spent half of the R\\&D budget, a sentense here.');
  const at = src.indexOf('half');
  const fetcher = (async () =>
    Response.json({
      matches: [
        {
          offset: at,
          length: 4,
          message: 'm',
          replacements: [
            { value: '50% of R&D' },
            { value: 'a_b {c} $d #e' },
            { value: 'say "hi"' },
          ],
          rule: { id: 'FAKE', category: { id: 'STYLE' } },
        },
      ],
    })) as unknown as typeof fetch;
  const [fake] = await checkGrammar(t.pool, store, users.owner.id, q.id, q.file, { url, fetcher });
  expect(fake.words).toBe('half');
  expect(fake.replacements).toEqual([
    '50\\% of R\\&D',
    'a\\_b \\{c\\} \\$d \\#e',
    'say \\symbol{34}hi\\symbol{34}',
  ]);
});

test('a finding is counted by those who may do what it counts, and on their own papers', async () => {
  const p = await paper();
  const other = await paper();
  const count = (who: keyof typeof users, project: { id: string }, outcome: string) =>
    code(recordGrammarOutcome(t.pool, users[who].id, project.id, 'grammar', outcome));
  // Changing the text, a word and a rule are the owner's; proposing is also the reviewer's.
  for (const outcome of ['changed', 'word', 'rule_off']) {
    expect(await count('owner', p, outcome)).toBe('ok');
    expect(await count('reviewer', p, outcome)).toBe('permission_denied');
    expect(await count('viewer', p, outcome)).toBe('permission_denied');
    expect(await count('outsider', p, outcome)).toBe('not_found');
  }
  expect(await count('owner', p, 'proposed')).toBe('ok');
  expect(await count('reviewer', p, 'proposed')).toBe('ok');
  expect(await count('viewer', p, 'proposed')).toBe('permission_denied');
  expect(await count('outsider', p, 'proposed')).toBe('not_found');
  // Counted on its own paper only.
  const sum = async (project: { id: string }) =>
    (
      await t.pool.query(
        'select coalesce(sum(count), 0)::int as n from grammar_outcomes where project_id = $1',
        [project.id],
      )
    ).rows[0].n;
  expect(await sum(p)).toBe(5);
  expect(await sum(other)).toBe(0);
  expect(await count('reviewer', other, 'proposed')).toBe('ok');
  expect(await sum(other)).toBe(1);
});

test('fifty checks of one unchanged file at once make one request to the checker', async () => {
  const p = await paper(MAIN + '% concurrent\n');
  let calls = 0;
  const fetcher: typeof fetch = async (...args) => {
    calls++;
    await new Promise((r) => setTimeout(r, 200));
    return fetch(...args);
  };
  const all = await Promise.all(
    Array.from({ length: 50 }, () =>
      checkGrammar(t.pool, store, users.owner.id, p.id, p.file, {
        url,
        fetcher,
        perMinute: 1000,
      }),
    ),
  );
  expect(calls).toBe(1);
  expect(all.every((f) => f.length === all[0].length && f.length > 0)).toBe(true);
});

test('one person may ask for only so many checks in a minute, and another is not held back', async () => {
  // The checks the tests above made are these people's too.
  await t.pool.query('delete from grammar_requests');
  const p = await paper(MAIN + '% limited\n');
  const ask = (who: keyof typeof users, perMinute: number) =>
    code(checkGrammar(t.pool, store, users[who].id, p.id, p.file, { url, perMinute }));
  for (let i = 0; i < 3; i++) expect(await ask('viewer', 3)).toBe('ok');
  expect(await ask('viewer', 3)).toBe('conflict');
  expect(await ask('reviewer', 3)).toBe('ok');
  await t.pool.query("update grammar_requests set created_at = now() - interval '2 minutes'");
  expect(await ask('viewer', 3)).toBe('ok');
});
