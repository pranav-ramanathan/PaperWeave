// Needs the services in infra/compose.yaml, the grammar checker among them. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import {
  changeLanguageSettings,
  checkGrammar,
  languageChange,
  languageSettings,
  setLanguageSettings,
} from './grammar.ts';
import { importZip, listFiles } from './import.ts';
import { recordGrammarOutcome } from './metrics.ts';
import { acceptInvitation, invite } from './projects.ts';
import { editFile, loadUpdates, TEXT } from './sync.ts';
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
// `withGuests: false` leaves out the reviewer and the viewer: one person may send 30 invitations an
// hour, and every paper made here sends two.
async function paper(main = MAIN, withGuests = true, extra: Record<string, string> = {}) {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(main) },
    { path: 'notes.txt', bytes: Buffer.from('teh recieve\n') },
    ...Object.entries(extra).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  ]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Grammar');
  for (const who of withGuests ? (['reviewer', 'viewer'] as const) : []) {
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, who);
    await acceptInvitation(t.pool, users[who].id, token);
  }
  const ids = Object.fromEntries(
    (await listFiles(t.pool, users.owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  return { id: project.id, file: ids['main.tex'], notes: ids['notes.txt'], ids };
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
      }),
    ),
  );
  expect(calls).toBe(1);
  expect(all.every((f) => f.length === all[0].length && f.length > 0)).toBe(true);
});

test('checks answered from what is kept are not counted, and the limit applies to requests to the checker', async () => {
  await t.pool.query('delete from grammar_requests');
  let calls = 0;
  const fetcher: typeof fetch = (...args) => (calls++, fetch(...args));
  const ask = (who: keyof typeof users, perMinute: number, file: { id: string; file: string }) =>
    code(
      checkGrammar(t.pool, store, users[who].id, file.id, file.file, { url, fetcher, perMinute }),
    );
  const p = await paper(MAIN + '% limited\n');
  // Repeated checks of an unchanged file: one request, the rest kept, none refused.
  for (let i = 0; i < 10; i++) expect(await ask('viewer', 2, p)).toBe('ok');
  expect(calls).toBe(1);
  // New texts are requests: two are allowed, the third is refused, and nothing was sent for it.
  const q = await paper(MAIN + '% second\n');
  const r = await paper(MAIN + '% third\n');
  expect(await ask('viewer', 2, q)).toBe('ok');
  expect(await ask('viewer', 2, r)).toBe('conflict');
  expect(calls).toBe(2);
  // Another person is not held back by it, and an unchanged file is still answered to the viewer.
  expect(await ask('reviewer', 2, r)).toBe('ok');
  expect(await ask('viewer', 2, p)).toBe('ok');
  await t.pool.query("update grammar_requests set created_at = now() - interval '2 minutes'");
  expect(await ask('viewer', 2, r)).toBe('ok');
});

test('a name written with TeX accents is matched and offered as the checker read it', async () => {
  const p = await paper(
    wrap('The H\\"older bound of Kov\\\'a\\v{c} and Kov\u00e1\u010d holds, a sentense.'),
  );
  const found = await check(p, 'owner');
  expect(found.find((f) => f.words === 'H\\"older')).toMatchObject({
    kind: 'spelling',
    reads: 'H\u00f6lder',
    addable: true,
  });
  expect(found.find((f) => f.words === "Kov\\'a\\v{c}")).toMatchObject({
    reads: 'Kov\u00e1\u010d',
    addable: true,
  });
  await setLanguageSettings(t.pool, users.owner.id, p.id, {
    glossary: ['h\u00f6lder', 'Kov\u00e1\u010d'],
  });
  const after = (await check(p, 'owner')).map((f) => f.words);
  expect(after).not.toContain('H\\"older');
  expect(after).not.toContain("Kov\\'a\\v{c}");
  expect(after).not.toContain('Kov\u00e1\u010d');
  expect(after).toContain('sentense');
});

test('text commands are read as what they print, so they cause no false findings', async () => {
  const p = await paper(
    wrap(
      'We ran 5\\,km and saw one sentense, two \\ldots and so on, written in \\LaTeX{}. See Vo\\ss ler for the the details.',
    ),
  );
  const found = await check(p, 'owner');
  const words = found.map((f) => f.words);
  expect(words).toContain('sentense');
  expect(words).toContain('the the');
  expect(found.find((f) => f.words === 'Vo\\ss ler')).toMatchObject({
    kind: 'spelling',
    reads: 'Voßler',
    addable: true,
  });
  expect(words).not.toContain('ler');
});

test('a list item may start in lower case; a sentence may not', async () => {
  const p = await paper(
    wrap(
      [
        'This is fine. this is not.',
        '\\begin{itemize}',
        '\\item A fast parser.',
        '\\item open-source code.',
        '\\item first, we parse it. it is fast.',
        '\\item a small one, and',
        '\\item the the last.',
        '\\end{itemize}',
        '\\begin{enumerate}',
        '\\item Parsing is quick.',
        '\\item lazy loading.',
        '\\end{enumerate}',
      ].join('\n'),
    ),
    false,
  );
  const found = await check(p, 'owner');
  const upper = found.filter((f) => f.rule === 'UPPERCASE_SENTENCE_START').map((f) => f.words);
  // A list item is not a sentence; the sentences in the paragraph and in an item are.
  expect(upper).toEqual(expect.arrayContaining(['this', 'it']));
  expect(upper.sort()).toEqual(['it', 'this']);
  for (const w of ['open', 'first', 'a', 'the', 'lazy'])
    expect(
      upper.some((u) => u.startsWith(w)),
      w,
    ).toBe(false);
  // Other mistakes in an item are still found.
  expect(found.some((f) => f.words.includes('the the'))).toBe(true);
});

test('mistakes in a description list and in a nested list are found', async () => {
  const src = wrap(
    [
      '\\begin{description}',
      '\\item[Parser] reads teh source.',
      '\\item[Teh recieve] A fine thing.',
      '\\item[Nested] A list follows.',
      '  \\begin{itemize}',
      '  \\item we saw the the result.',
      '  \\end{itemize}',
      '\\item[Code] Listing follows.',
      '\\begin{verbatim}',
      'teh',
      '\\end{verbatim}',
      '\\end{description}',
    ].join('\n'),
  );
  const p = await paper(src, false);
  const found = await check(p, 'owner');
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, p.file)) Y.applyUpdate(doc, u);
  const text = doc.getText(TEXT).toString();
  const at = (b64: string) =>
    Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(b64, 'base64')),
      doc,
    )!.index;
  const teh = found.find((f) => f.words === 'teh');
  expect(teh).toBeDefined();
  const [from, to] = [at(teh!.from), at(teh!.to)];
  expect(text.slice(from, to)).toBe('teh');
  expect(text.slice(from - 20, to + 8)).toBe('\\item[Parser] reads teh source.');
  expect(found.some((f) => f.words.includes('the the'))).toBe(true);
  // Nothing in a term, in the listing, or on the word after the term.
  for (const f of found) {
    expect(f.words).not.toMatch(/recieve/i);
    expect(at(f.from)).not.toBe(text.indexOf('teh\n\\end{verbatim}'));
    expect(at(f.from)).not.toBe(text.indexOf('Teh recieve'));
  }
  expect(found.some((f) => f.rule === 'UPPERCASE_SENTENCE_START' && f.words === 'reads')).toBe(
    false,
  );
  // Taking the suggestion changes only the word.
  const fix = teh!.replacements.find((r) => r === 'the');
  expect(fix).toBe('the');
  expect(text.slice(0, from) + fix + text.slice(to)).toContain('\\item[Parser] reads the source.');
});

test("a paper's own text macros are read as the words they print, from the package that defines them", async () => {
  const p = await paper(
    [
      '\\documentclass{article}',
      '\\usepackage{own}',
      '\\begin{document}',
      '\\input{sec}',
      '\\end{document}',
      '',
    ].join('\n'),
    false,
    {
      'own.sty': '\\newcommand{\\dbs}{databases}\n\\newcommand{\\etc}{etc}\n',
      'sec.tex': 'These \\dbs is used here.\n\nWe use it \\etc. it works.\n',
    },
  );
  const sec = { id: p.id, file: p.ids['sec.tex'] };
  let calls = 0;
  const fetcher: typeof fetch = (...args) => (calls++, fetch(...args));
  const ask = () => checkGrammar(t.pool, store, users.owner.id, sec.id, sec.file, { url, fetcher });
  const found = await ask();
  // Read as "These databases is used", it is wrong, and the finding is on a word of the prose.
  expect(found.some((f) => f.words === 'is')).toBe(true);
  // Read as a stand-in noun, "\etc." made "it" start a sentence. It does not.
  expect(found.some((f) => f.words === 'it')).toBe(false);
  // What the checker is told is never what a finding is made of.
  for (const f of found) expect(f.words).not.toContain('\\');
  const first = calls;
  expect(first).toBe(1);
  await ask();
  expect(calls).toBe(first);

  // The package changes; this file does not. What the checker reads has changed, so it is asked.
  await editFile(t.pool, store, p.ids['own.sty'], users.owner.id, (text) => {
    const at = text.toString().indexOf('databases');
    text.delete(at, 'databases'.length);
    text.insert(at, 'database');
  });
  const after = await ask();
  expect(calls).toBe(first + 1);
  expect(after.some((f) => f.words === 'is')).toBe(false);
});

// Joins a paper without an invitation: one person may send 30 an hour and this file's papers use them.
const member = (p: { id: string }, who: keyof typeof users, role: string) =>
  t.pool.query('insert into project_members (project_id, user_id, role) values ($1, $2, $3)', [
    p.id,
    users[who].id,
    role,
  ]);

test('words and rules added since a page was drawn survive its save', async () => {
  const p = await paper(MAIN, false);
  const owner = users.owner.id;
  const now = () => languageSettings(t.pool, owner, p.id);
  await setLanguageSettings(t.pool, owner, p.id, { glossary: ['Alpha'], off: ['RULE_A'] });
  const shown = await now();
  // Elsewhere, since the page was drawn: a word is made the paper's own, a rule is switched off.
  await changeLanguageSettings(t.pool, owner, p.id, { addWords: ['Weavely'] });
  await changeLanguageSettings(t.pool, owner, p.id, { rulesOff: ['RULE_B'] });
  // The page is saved: the person chose American spelling and added Beta.
  await changeLanguageSettings(
    t.pool,
    owner,
    p.id,
    languageChange(shown, { language: 'en-US', glossary: ['Alpha', 'Beta'], off: ['RULE_A'] }),
  );
  expect(await now()).toEqual({
    language: 'en-US',
    glossary: ['Alpha', 'Beta', 'Weavely'],
    off: ['RULE_A', 'RULE_B'],
  });
  // A word removed on the page, and a rule ticked off, are gone; the rest stays.
  await changeLanguageSettings(t.pool, owner, p.id, { dropWords: ['Alpha'], rulesOn: ['RULE_A'] });
  expect(await now()).toEqual({
    language: 'en-US',
    glossary: ['Beta', 'Weavely'],
    off: ['RULE_B'],
  });
  // A language the person did not touch stays as it now is.
  const drawn = await now();
  await setLanguageSettings(t.pool, owner, p.id, { language: 'en-GB' });
  await changeLanguageSettings(t.pool, owner, p.id, languageChange(drawn, drawn));
  expect((await now()).language).toBe('en-GB');
});

test('twenty words added at once are all kept', async () => {
  const p = await paper(MAIN, false);
  await member(p, 'outsider', 'editor');
  const words = Array.from({ length: 20 }, (_, i) => `Word${String.fromCharCode(97 + i)}`);
  await Promise.all(
    words.map((w, i) =>
      changeLanguageSettings(t.pool, users[i % 2 ? 'owner' : 'outsider'].id, p.id, {
        addWords: [w],
      }),
    ),
  );
  expect((await languageSettings(t.pool, users.owner.id, p.id)).glossary).toEqual(
    [...words].sort((a, b) => a.localeCompare(b)),
  );
});

test('changing language settings is for those who may write, and refuses what cannot be used', async () => {
  const p = await paper(MAIN, false);
  await member(p, 'reviewer', 'reviewer');
  await member(p, 'viewer', 'viewer');
  const now = () => languageSettings(t.pool, users.owner.id, p.id);
  const change = (who: keyof typeof users, input: object) =>
    code(changeLanguageSettings(t.pool, users[who].id, p.id, input));
  expect(await change('reviewer', { addWords: ['x'] })).toBe('permission_denied');
  expect(await change('viewer', { rulesOff: ['X'] })).toBe('permission_denied');
  expect(await change('outsider', { addWords: ['x'] })).toBe('not_found');
  const before = await now();
  for (const input of [
    { addWords: ['two words'] },
    { rulesOff: ['bad; rule'] },
    { language: 'fr' },
    { addWords: 'Weavely' },
  ]) {
    expect(await change('owner', input)).toBe('invalid_input');
    expect(await now()).toEqual(before);
  }
  const many = Array.from({ length: 2000 }, (_, i) => `w${i}`);
  expect(await change('owner', { addWords: many })).toBe('ok');
  expect(await change('owner', { addWords: ['one-more'] })).toBe('invalid_input');
  expect((await now()).glossary).toHaveLength(2000);
  // An old word stays removable, whatever it looks like now.
  expect(await change('owner', { dropWords: ['no longer a word'] })).toBe('ok');
});
