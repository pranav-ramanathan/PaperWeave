// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { importZip, listFiles } from './import.ts';
import { labelIndex } from '@paperweave/latex';
import { readZip } from './archive.ts';
import { exportZip } from './import.ts';
import { labelReport, paperMacros, paperProse, proposeLabelRename, renameLabel } from './labels.ts';
import { acceptInvitation, invite } from './projects.ts';
import { editFile } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let outsider: { id: string };
let viewer: { id: string; email: string };

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  outsider = await t.signIn('outsider@example.org');
  viewer = await t.signIn('viewer@example.org');
});
afterAll(() => t.close());

test('labels are listed file by file, with references that miss and names used twice', async () => {
  const zip = await writeZip(
    Object.entries({
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\input{sections/b}',
        '\\input{sections/a}',
        'See \\ref{sec:a}, \\ref{sec:nowhere} and \\eqref{eq:one}.',
        '\\end{document}',
        '',
      ].join('\n'),
      'sections/a.tex':
        '\\section{A}\\label{sec:a}\n\\begin{equation}x\\label{eq:one}\\end{equation}\n',
      'sections/b.tex':
        '\\section{B}\\label{sec:b}\nAs in \\cref{sec:a,sec:gone}.\n\\label{eq:one}\n',
      // Not included by anything: its labels are not part of the paper.
      'old/draft.tex': '\\label{sec:a}\\ref{sec:never}\n',
    }).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Labels');
  const report = await labelReport(t.pool, store, owner.id, project.id);
  expect(report.labels.map((l) => `${l.path}:${l.line} ${l.key}`)).toEqual([
    'sections/b.tex:1 sec:b',
    'sections/b.tex:3 eq:one',
    'sections/a.tex:1 sec:a',
    'sections/a.tex:2 eq:one',
  ]);
  expect(report.undefined.map((r) => `${r.path}:${r.line} ${r.command} ${r.key}`)).toEqual([
    'main.tex:5 ref sec:nowhere',
    'sections/b.tex:2 cref sec:gone',
  ]);
  expect(report.duplicates.map((d) => [d.key, d.places.map((p) => p.path)])).toEqual([
    ['eq:one', ['sections/b.tex', 'sections/a.tex']],
  ]);

  // It follows the text as it is now, not as it was uploaded.
  const files = await listFiles(t.pool, owner.id, project.id);
  const main = files.find((f) => f.path === 'main.tex')!;
  await editFile(t.pool, store, main.id, owner.id, (text) => {
    const at = text.toString().indexOf('See ');
    text.insert(at, '\\label{sec:nowhere}\n');
  });
  const now = await labelReport(t.pool, store, owner.id, project.id);
  expect(now.undefined.map((r) => r.key)).toEqual(['sec:gone']);
  expect(now.labels[0]).toMatchObject({ key: 'sec:nowhere', path: 'main.tex', line: 5 });

  await expect(labelReport(t.pool, store, outsider.id, project.id)).rejects.toMatchObject({
    code: 'not_found',
  });
});

const FILES = {
  'main.tex': [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\input{sections/a}',
    'See \\ref{sec:a} and \\ref{sec:a}, then \\eqref{eq:one}. % once was \\ref{sec:a}',
    '\\end{document}',
    '',
  ].join('\r\n'),
  'sections/a.tex': '\\section{A}\\label{sec:a}\nAs in \\cref{eq:one, sec:a}.\n\\label{eq:one}\n',
  // Not part of the paper as built, but still one of its files.
  'old/draft.tex': 'An old \\ref{sec:a} and \\ref{sec:ab}.\n\\label{sec:ab}\n',
};
async function paper() {
  const zip = await writeZip(
    Object.entries(FILES).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Rename');
  const { token } = await invite(t.pool, owner.id, project.id, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  return project.id;
}
const texts = async (project: string) =>
  Object.fromEntries(
    (await readZip(await exportZip(t.pool, store, owner.id, project))).entries.map((e) => [
      e.path,
      Buffer.from(e.bytes).toString(),
    ]),
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test('renaming a label shows every line it would change, then changes exactly those', async () => {
  const project = await paper();
  const proposal = await proposeLabelRename(t.pool, store, owner.id, project, 'sec:a', 'sec:alpha');
  expect(proposal.changes.map((c) => [`${c.path}:${c.line}`, c.before, c.after])).toEqual([
    ['main.tex:4', expect.stringContaining('\\ref{sec:a} and'), expect.stringContaining('then')],
    [
      'old/draft.tex:1',
      'An old \\ref{sec:a} and \\ref{sec:ab}.',
      'An old \\ref{sec:alpha} and \\ref{sec:ab}.',
    ],
    ['sections/a.tex:1', '\\section{A}\\label{sec:a}', '\\section{A}\\label{sec:alpha}'],
    ['sections/a.tex:2', 'As in \\cref{eq:one, sec:a}.', 'As in \\cref{eq:one, sec:alpha}.'],
  ]);
  // Two references on one line are one change; the commented-out one is left alone.
  expect(proposal.changes[0].after).toBe(
    'See \\ref{sec:alpha} and \\ref{sec:alpha}, then \\eqref{eq:one}. % once was \\ref{sec:a}',
  );
  // Proposing changes nothing.
  expect(await texts(project)).toEqual(FILES);

  const done = await renameLabel(
    t.pool,
    store,
    owner.id,
    project,
    'sec:a',
    'sec:alpha',
    proposal.digest,
  );
  expect(done).toEqual({ places: 5 });
  const after = await texts(project);
  // Every reference followed, in every file, and nothing else moved: line ends included.
  expect(after['main.tex']).toBe(
    FILES['main.tex'].replace(
      '\\ref{sec:a} and \\ref{sec:a},',
      '\\ref{sec:alpha} and \\ref{sec:alpha},',
    ),
  );
  expect(after['sections/a.tex']).toBe(FILES['sections/a.tex'].replaceAll('sec:a', 'sec:alpha'));
  expect(after['old/draft.tex']).toBe(FILES['old/draft.tex'].replace('{sec:a}', '{sec:alpha}'));
  for (const text of Object.values(after)) {
    const found = labelIndex(text);
    expect([...found.labels, ...found.refs].filter((x) => x.key === 'sec:a')).toEqual([]);
  }
  expect((await labelReport(t.pool, store, owner.id, project)).undefined).toEqual([]);
});

test('a rename is refused whole when the text has moved on, the name is taken or unusable, or the person may not write', async () => {
  const project = await paper();
  const proposal = await proposeLabelRename(t.pool, store, owner.id, project, 'sec:a', 'sec:alpha');
  // Someone adds another reference after the changes were shown.
  const files = await listFiles(t.pool, owner.id, project);
  const a = files.find((f) => f.path === 'sections/a.tex')!;
  await editFile(t.pool, store, a.id, owner.id, (text) =>
    text.insert(text.length, 'Again \\ref{sec:a}.\n'),
  );
  const before = await texts(project);
  const rename = (who: string, from: unknown, to: unknown, digest = proposal.digest) =>
    code(renameLabel(t.pool, store, who, project, from, to, digest));
  expect(await rename(owner.id, 'sec:a', 'sec:alpha')).toBe('conflict');
  expect(await rename(owner.id, 'sec:a', 'eq:one')).toBe('conflict');
  expect(await rename(owner.id, 'sec:none', 'sec:new')).toBe('invalid_input');
  expect(await rename(owner.id, 'sec:a', 'sec:a')).toBe('invalid_input');
  for (const bad of ['', 'two words', 'a,b', 'a}b', 'a\\b', 'a%b', 'x'.repeat(201), 7, null])
    expect(await rename(owner.id, 'sec:a', bad), JSON.stringify(bad)).toBe('invalid_input');
  expect(await rename(viewer.id, 'sec:a', 'sec:alpha')).toBe('permission_denied');
  expect(await rename(outsider.id, 'sec:a', 'sec:alpha')).toBe('not_found');
  expect(await code(proposeLabelRename(t.pool, store, viewer.id, project, 'sec:a', 'sec:b'))).toBe(
    'permission_denied',
  );
  expect(await texts(project)).toEqual(before);
  // Looked at again, it goes through, the new reference included.
  const again = await proposeLabelRename(t.pool, store, owner.id, project, 'sec:a', 'sec:alpha');
  expect(
    await renameLabel(t.pool, store, owner.id, project, 'sec:a', 'sec:alpha', again.digest),
  ).toEqual({
    places: 6,
  });
  expect((await texts(project))['sections/a.tex']).toContain('Again \\ref{sec:alpha}.');
});

test('hyperref, fref, Fref and zcref references follow a renamed label', async () => {
  const zip = await writeZip([
    {
      path: 'main.tex',
      bytes: Buffer.from(
        '\\documentclass{article}\n\\begin{document}\n\\section{A}\\label{sec:a}\n\\hyperref[sec:a]{x} \\fref{sec:a} \\Fref{sec:a} \\zcref{sec:a}\n',
      ),
    },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Hyper');
  const proposal = await proposeLabelRename(t.pool, store, owner.id, project.id, 'sec:a', 'sec:b');
  await renameLabel(t.pool, store, owner.id, project.id, 'sec:a', 'sec:b', proposal.digest);
  expect((await texts(project.id))['main.tex']).toBe(
    '\\documentclass{article}\n\\begin{document}\n\\section{A}\\label{sec:b}\n\\hyperref[sec:b]{x} \\fref{sec:b} \\Fref{sec:b} \\zcref{sec:b}\n',
  );
});

test("paperProse reads the root's preamble and the project's own packages, and only for members", async () => {
  const zip = await writeZip(
    Object.entries({
      'main.tex': [
        '\\documentclass{article}',
        '\\usepackage{local}',
        '\\newtheorem{observation}{Observation}',
        '% \\newtheorem{ghost}{Ghost}',
        '\\begin{document}',
        '\\newtheorem{late}{Late}',
        '\\end{document}',
        '',
      ].join('\n'),
      'local.sty': '\\newtheorem{fact}{Fact}\n\\declaretheorem{axiom}\n',
      'unused.sty': '\\newtheorem{unused}{Unused}\n',
    }).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Prose');
  expect(await paperProse(t.pool, store, owner.id, project.id)).toEqual([
    'axiom',
    'fact',
    'observation',
  ]);
  // It follows the text as it is now, as the macros do.
  const files = await listFiles(t.pool, owner.id, project.id);
  const sty = files.find((f) => f.path === 'local.sty')!;
  await editFile(t.pool, store, sty.id, owner.id, (text) =>
    text.insert(0, '\\newtheorem{notice}{N}\n'),
  );
  expect(await paperProse(t.pool, store, owner.id, project.id)).toContain('notice');
  await expect(paperProse(t.pool, store, outsider.id, project.id)).rejects.toMatchObject({
    code: 'not_found',
  });
});

test("paperMacros reads in TeX's order and the project's own packages, and only for members", async () => {
  const zip = await writeZip(
    Object.entries({
      'main.tex': [
        '\\documentclass{article}',
        '\\input{defs}',
        '\\usepackage{local}',
        '\\renewcommand{\\R}{\\mathbb{Q}}',
        '\\newcommand{\\hide}[1]{}',
        '\\begin{document}',
        '$\\R \\norm{x}$',
        '\\end{document}',
        '',
      ].join('\n'),
      'defs.tex': '\\newcommand{\\R}{\\mathbb{R}}\n',
      'local.sty': '\\newcommand{\\norm}[1]{\\lVert #1\\rVert}\n',
      'unused.sty': '\\newcommand{\\unused}{u}\n',
    }).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Macros');
  expect(await paperMacros(t.pool, store, owner.id, project.id)).toEqual({
    '\\R': '\\mathbb{Q}',
    '\\norm': '\\lVert #1\\rVert',
    '\\hide': '\\@secondoftwo{#1}{}',
  });
  const files = await listFiles(t.pool, owner.id, project.id);
  const sty = files.find((f) => f.path === 'local.sty')!;
  await editFile(t.pool, store, sty.id, owner.id, (text) =>
    text.insert(0, '\\newcommand{\\fresh}{f}\n'),
  );
  expect(await paperMacros(t.pool, store, owner.id, project.id)).toHaveProperty(['\\fresh'], 'f');
  await expect(paperMacros(t.pool, store, outsider.id, project.id)).rejects.toMatchObject({
    code: 'not_found',
  });
});
