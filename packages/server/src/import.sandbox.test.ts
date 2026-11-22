// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { compile } from '../../../apps/workers/src/compile.ts';
import { type Entry, LIMITS, readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { exportRevision, listRevisions, saveRevision } from './revisions.ts';
import { exportZip, importReport, importZip, listFiles } from './import.ts';
import { createFile, setRootFile } from './files.ts';
import { acceptInvitation, createProject, invite, listProjects, getProject } from './projects.ts';
import { TEST_ENV, testDb } from './testing.ts';

const FIXTURES = join(import.meta.dirname, '../../../fixtures');
const store = blobStore(TEST_ENV);
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let viewer: { id: string; email: string };
let outsider: { id: string };

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  viewer = await t.signIn('viewer@example.org');
  outsider = await t.signIn('outsider@example.org');
});
afterAll(() => t.close());

/** A fixture project's files, with an optional folder in front of every path. */
function fixture(name: string, prefix = ''): Entry[] {
  const root = join(FIXTURES, name);
  const out: Entry[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: prefix + relative(root, p), bytes: readFileSync(p) });
    }
  };
  walk(root);
  return out;
}

type Raw = {
  name: string;
  data?: Buffer;
  attr?: number;
  flags?: number;
  deflated?: Buffer;
  claim?: number;
};
/** A ZIP written byte by byte, so it can say things a well-behaved writer never would. */
function rawZip(files: Raw[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = f.deflated ?? f.data ?? Buffer.alloc(0);
    const real = f.data ?? Buffer.alloc(0);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(f.flags ?? 0, 6);
    head.writeUInt16LE(f.deflated ? 8 : 0, 8);
    head.writeUInt32LE(crc32(real), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(f.claim ?? real.length, 22);
    head.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    head.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(f.attr ?? 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(head, name, data);
    central.push(entry, name);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
const MAIN = Buffer.from('\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');
const main: Raw = { name: 'main.tex', data: MAIN };
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test.each(['article-basic', 'ieee-multifile', 'ams-multifile'])(
  '%s imports and exports byte for byte',
  async (name) => {
    const files = fixture(name);
    const [project] = await importZip(t.pool, store, owner.id, await writeZip(files), name);
    expect(project).toMatchObject({ name, role: 'owner' });
    const report = (await importReport(t.pool, owner.id, project.id))!;
    expect(report).toMatchObject({
      root: 'main.tex',
      compiler: 'pdflatex',
      missing: [],
      cycles: [],
      otherRoots: [],
    });
    expect((await listFiles(t.pool, owner.id, project.id)).map((f) => f.path)).toEqual(
      files.map((f) => f.path).sort(),
    );
    const back = await readZip(await exportZip(t.pool, store, owner.id, project.id));
    expect(back.entries.length).toBe(files.length);
    for (const f of files)
      expect(
        Buffer.from(back.entries.find((e) => e.path === f.path)!.bytes).equals(f.bytes),
        f.path,
      ).toBe(true);
  },
);

test('the report says what is visual, what is source-only and what was left out', async () => {
  const files = [
    ...fixture('ieee-multifile', 'My Paper/'),
    ...fixture('encodings', 'My Paper/enc/'),
    { path: 'My Paper/latexmkrc', bytes: Buffer.from('system("rm -rf /");') },
    { path: 'My Paper/main.aux', bytes: Buffer.from('\\relax') },
    { path: 'My Paper/notes.docx', bytes: Buffer.from('PK') },
    { path: '__MACOSX/My Paper/._main.tex', bytes: Buffer.from('x') },
  ];
  const [project] = await importZip(t.pool, store, owner.id, await writeZip(files), 'fallback');
  // The wrapping folder is taken off every path. A paper that is alone is named after its ZIP.
  expect(project.name).toBe('fallback');
  const report = (await importReport(t.pool, owner.id, project.id))!;
  const file = (path: string) => report.files.find((f) => f.path === path);
  expect(file('macros.tex')).toEqual({ path: 'macros.tex', sourceOnly: true });
  expect(file('sections/intro.tex')!.visual!.editable).toBeGreaterThan(500);
  expect(file('refs.bib')).toEqual({ path: 'refs.bib' });
  expect(file('enc/latin1.tex')).toEqual({ path: 'enc/latin1.tex', readonly: 'not-utf8' });
  expect(file('enc/mixed.tex')).toEqual({ path: 'enc/mixed.tex', readonly: 'mixed-newlines' });
  expect(report.skipped).toEqual([
    { path: 'My Paper/latexmkrc', reason: 'build script, never run' },
    { path: 'My Paper/main.aux', reason: 'build output, made again on compile' },
    { path: 'My Paper/notes.docx', reason: 'not a file type a paper uses' },
  ]);
  expect(report.notes.join(' ')).toMatch(/Comments, history and sharing settings.*never runs it/);
  // Files that cannot be edited still come back out exactly.
  const back = await readZip(await exportZip(t.pool, store, owner.id, project.id));
  for (const f of fixture('encodings', 'enc/'))
    expect(
      Buffer.from(back.entries.find((e) => e.path === f.path)!.bytes).equals(f.bytes),
      f.path,
    ).toBe(true);
});

test('an archive of several papers becomes several papers', async () => {
  const zip = await writeZip([
    ...fixture('article-basic', 'export/alpha/'),
    ...fixture('ams-multifile', 'export/beta/'),
    { path: 'export/export-errors.json', bytes: Buffer.from('[]') },
    { path: 'export/conversations/1.json', bytes: Buffer.from('{}') },
  ]);
  const made = await importZip(t.pool, store, outsider.id, zip, 'fallback');
  expect(made.map((p) => p.name)).toEqual(['alpha', 'beta']);
  const report = (await importReport(t.pool, outsider.id, made[1].id))!;
  expect(report.root).toBe('main.tex');
  expect(report.skipped.map((s) => s.path)).toEqual([
    'export/export-errors.json',
    'export/conversations/1.json',
  ]);
});

test('one person can start only so many papers in an hour, however they start them', async () => {
  const busy = await t.signIn('busy@example.org');
  const limits = { ...LIMITS, papersPerHour: 3 };
  const two = await writeZip([
    ...fixture('article-basic', 'alpha/'),
    ...fixture('article-basic', 'beta/'),
  ]);
  const one = await writeZip(fixture('article-basic'));
  const count = async () => (await listProjects(t.pool, busy.id)).length;
  const refused = (p: Promise<unknown>) =>
    p.then(
      () => 'made',
      (e) => e.code,
    );

  await createProject(t.pool, busy.id, 'By hand', 3);
  await importZip(t.pool, store, busy.id, one, 'From an archive', limits);
  // An archive of two would make four: it is refused whole, and makes none.
  expect(await refused(importZip(t.pool, store, busy.id, two, 'Two', limits))).toBe('conflict');
  expect(await count()).toBe(2);
  await createProject(t.pool, busy.id, 'The third', 3);
  expect(await refused(createProject(t.pool, busy.id, 'A fourth', 3))).toBe('conflict');
  expect(await refused(importZip(t.pool, store, busy.id, one, 'A fourth', limits))).toBe(
    'conflict',
  );
  expect(await count()).toBe(3);
  // It is each person's own count, and a paper started more than an hour ago is not in it.
  await importZip(t.pool, store, viewer.id, two, 'Someone else', limits);
  await t.pool.query(
    `update projects set created_at = now() - interval '61 minutes' where name = 'By hand'
     and id in (select project_id from project_members where user_id = $1)`,
    [busy.id],
  );
  await createProject(t.pool, busy.id, 'An hour later', 3);
  expect(await count()).toBe(4);
});

test('the compiler is read from the root file', async () => {
  const paper = (preamble: string) =>
    writeZip([
      { path: 'main.tex', bytes: Buffer.from(`${preamble}\n\\begin{document}x\\end{document}\n`) },
    ]);
  const compiler = async (preamble: string) =>
    (await importReport(
      t.pool,
      outsider.id,
      (await importZip(t.pool, store, outsider.id, await paper(preamble), 'p'))[0].id,
    ))!.compiler;
  expect(await compiler('\\documentclass{article}\\usepackage{fontspec}')).toBe('xelatex');
  expect(await compiler('% !TEX program = lualatex\n\\documentclass{article}')).toBe('lualatex');
  expect(await compiler('\\documentclass{article}\\usepackage{amsmath}')).toBe('pdflatex');
});

test('hostile and broken archives are refused whole', async () => {
  const fresh = await t.signIn('careful@example.org');
  const small = { ...LIMITS, files: 3, fileBytes: 1000, totalBytes: 1500 };
  const zeros = Buffer.alloc(200_000);
  const hostile: Record<string, Buffer> = {
    'path that climbs out': rawZip([main, { name: '../evil.tex', data: MAIN }]),
    'climbing with backslashes': rawZip([main, { name: '..\\..\\evil.tex', data: MAIN }]),
    'absolute path': rawZip([main, { name: '/etc/cron.d/evil.tex', data: MAIN }]),
    'symbolic link': rawZip([
      main,
      { name: 'link.tex', data: Buffer.from('/etc/passwd'), attr: (0o120777 << 16) >>> 0 },
    ]),
    'same file twice': rawZip([main, main]),
    // 0x800 marks the name as UTF-8. Without it the byte reads as a harmless CP437 symbol.
    'control character in a name': rawZip([
      main,
      { name: 'a\u0007b.tex', data: MAIN, flags: 0x800 },
    ]),
    'password-protected entry': rawZip([main, { name: 'secret.tex', data: MAIN, flags: 1 }]),
    'too many files': rawZip([main, ...[1, 2, 3].map((i) => ({ name: `f${i}.tex`, data: MAIN }))]),
    'one file too large': rawZip([main, { name: 'big.tex', data: zeros }]),
    'too much data in total': rawZip([
      main,
      { name: 'a.tex', data: zeros.subarray(0, 900) },
      { name: 'b.tex', data: zeros.subarray(0, 900) },
    ]),
    // The classic bomb: a tiny entry that claims to be tiny and unpacks to far more.
    'entry that lies about its size': rawZip([
      main,
      { name: 'bomb.tex', data: zeros, deflated: deflateRawSync(zeros), claim: 100 },
    ]),
    'not a ZIP at all': Buffer.from('This is not a ZIP file. '.repeat(20)),
    'cut off half way': (await writeZip(fixture('article-basic'))).subarray(0, 900) as Buffer,
    'no root file': Buffer.from(await writeZip(fixture('encodings'))),
  };
  for (const [what, zip] of Object.entries(hostile))
    expect(await code(importZip(t.pool, store, fresh.id, zip, 'x', small)), what).toBe(
      'invalid_input',
    );
  expect(
    await code(importZip(t.pool, store, fresh.id, Buffer.alloc(LIMITS.archiveBytes + 1), 'x')),
  ).toBe('invalid_input');
  // Nothing was created by any of them.
  expect(await listProjects(t.pool, fresh.id)).toEqual([]);
});

test('files and exports are only for people on the paper', async () => {
  const [project] = await importZip(
    t.pool,
    store,
    owner.id,
    await writeZip(fixture('article-basic')),
    'p',
  );
  const { token } = await invite(t.pool, owner.id, project.id, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  expect((await listFiles(t.pool, viewer.id, project.id)).length).toBe(2);
  expect(await code(exportZip(t.pool, store, viewer.id, project.id))).toBe('permission_denied');
  expect(await code(listFiles(t.pool, outsider.id, project.id))).toBe('not_found');
  expect(await code(importReport(t.pool, outsider.id, project.id))).toBe('not_found');
  expect(await code(exportZip(t.pool, store, outsider.id, project.id))).toBe('not_found');
});

test('the root file travels with the review data', async () => {
  const doc = (word: string) =>
    Buffer.from(`\\documentclass{article}\n\\begin{document}\n${word}\n\\end{document}\n`);
  const [original] = await importZip(
    t.pool,
    store,
    owner.id,
    await writeZip([
      { path: 'main.tex', bytes: doc('Spare') },
      { path: 'paper.tex', bytes: doc('The paper') },
    ]),
    'Rooted',
  );
  // The importer prefers main.tex; the author made paper.tex the root.
  expect((await importReport(t.pool, owner.id, original.id))!.root).toBe('main.tex');
  const files = await listFiles(t.pool, owner.id, original.id);
  await setRootFile(t.pool, owner.id, original.id, files.find((f) => f.path === 'paper.tex')!.id);
  const zip = await exportZip(t.pool, store, owner.id, original.id, { review: true });
  const [arrived] = await importZip(t.pool, store, owner.id, zip, 'Arrived');
  expect((await getProject(t.pool, owner.id, arrived.id)).root).toBe('paper.tex');
  const report = (await importReport(t.pool, owner.id, arrived.id))!;
  expect(report).toMatchObject({ root: 'paper.tex', otherRoots: ['main.tex'] });
  expect(report.notes).toContain('The root file is paper.tex, as it was where this came from.');
  // A plain ZIP is as it was.
  const [plain] = await importZip(
    t.pool,
    store,
    owner.id,
    await exportZip(t.pool, store, owner.id, original.id),
    'Plain',
  );
  expect((await getProject(t.pool, owner.id, plain.id)).root).toBe('main.tex');
  // A root the paper does not have is said, and the importer's choice stands.
  const review = JSON.stringify({
    format: 'paperweave-review-1',
    paper: 'x',
    exported: '2026-01-01T00:00:00.000Z',
    root: 'gone.tex',
    threads: [],
    proposals: [],
  });
  const [odd] = await importZip(
    t.pool,
    store,
    owner.id,
    await writeZip([
      { path: 'main.tex', bytes: doc('Spare') },
      { path: 'paperweave-review.json', bytes: Buffer.from(review) },
    ]),
    'Odd',
  );
  expect((await getProject(t.pool, owner.id, odd.id)).root).toBe('main.tex');
  expect((await importReport(t.pool, owner.id, odd.id))!.notes.join('\n')).toContain(
    'the root file was gone.tex, but the paper has no such .tex file',
  );
});

// ---- the shapes real papers come in

const doc = (body = 'Hello.', pre = '') =>
  `\\documentclass{article}\n${pre}\\begin{document}\n${body}\n\\end{document}\n`;
const file = (path: string, text: string | Buffer): Entry => ({
  path,
  bytes: Buffer.from(text),
});
const reportOf = async (userId: string, files: Entry[], name = 'Shape') => {
  const made = await importZip(t.pool, store, userId, await writeZip(files), name);
  return {
    made,
    report: (await importReport(t.pool, userId, made[0].id))!,
    paths: (await listFiles(t.pool, userId, made[0].id)).map((f) => f.path),
  };
};
const refused = (zip: Uint8Array) =>
  importZip(t.pool, store, owner.id, zip, 'x').then(
    () => 'imported',
    (e) => `${e.code}: ${e.message}`,
  );

test('a root in a folder, with files beside the folder, imports whole and is still the root', async () => {
  const { made, report, paths } = await reportOf(owner.id, [
    file('src/main.tex', doc('\\input{../parts/a}')),
    file('parts/a.tex', 'A.'),
    file('figures/a.png', 'png'),
    file('refs.bib', '@book{k, title={T}}'),
  ]);
  expect(report.root).toBe('src/main.tex');
  expect(report.missing).toEqual([]);
  expect(report.skipped).toEqual([]);
  expect(paths).toEqual(['figures/a.png', 'parts/a.tex', 'refs.bib', 'src/main.tex']);
  expect(made[0].name).toBe('Shape');
  // A wrapping folder that holds all of it still goes.
  const wrapped = await reportOf(owner.id, [
    file('proj/src/main.tex', doc()),
    file('proj/figures/a.png', 'png'),
  ]);
  expect(wrapped.paths).toEqual(['figures/a.png', 'src/main.tex']);
  expect(wrapped.report.root).toBe('src/main.tex');
});

test('files shared between several papers are left out, and the report says why', async () => {
  const { report } = await reportOf(owner.id, [
    file('paper/main.tex', doc()),
    file('poster/poster.tex', doc()),
    file('figures/a.png', 'png'),
  ]);
  expect(report.skipped).toEqual([
    {
      path: 'figures/a.png',
      reason: 'shared between the papers in this archive: add it to each paper that needs it',
    },
  ]);
});

test('a .bbl is kept when the archive has no .bib file, and the report says so', async () => {
  const bbl = '\\begin{thebibliography}{1}\\bibitem{k} A.\\end{thebibliography}\n';
  const alone = await reportOf(owner.id, [
    file('main.tex', doc('\\cite{k}\\bibliography{refs}')),
    file('main.bbl', bbl),
  ]);
  expect(alone.paths).toEqual(['main.bbl', 'main.tex']);
  expect(alone.report.skipped).toEqual([]);
  expect(alone.report.notes).toContain(
    'The bibliography came ready-made (main.bbl), with no .bib file: citations cannot be checked or added here.',
  );
  // With a .bib file it is build output as before.
  const both = await reportOf(owner.id, [
    file('main.tex', doc()),
    file('main.bbl', bbl),
    file('refs.bib', '@book{k, title={T}}'),
  ]);
  expect(both.paths).toEqual(['main.tex', 'refs.bib']);
  expect(both.report.skipped).toEqual([
    { path: 'main.bbl', reason: 'build output, made again on compile' },
  ]);
  expect(both.report.notes.join(' ')).not.toMatch(/ready-made/);
});

test('the file types real papers use are kept; pictures LaTeX cannot read are skipped, with a reason', async () => {
  const kept = [
    ...['x.tikz', 'x.pgf', 'x.pdf_tex', 'x.dat', 'x.lua', 'x.ist', 'x.inc', 'x.fd', 'x.ldf'].map(
      (p) => file(p, 'text\n'),
    ),
    file('x.ttf', Buffer.from([0, 1, 0, 0, 255])),
    file('x.otf', Buffer.from('OTTO\u00ff', 'latin1')),
  ];
  const svgs = ['x.svg', 'x.gif', 'x.tif', 'x.tiff', 'x.bmp'].map((p) => file(p, 'x'));
  const { report, paths } = await reportOf(owner.id, [file('main.tex', doc()), ...kept, ...svgs]);
  expect(paths).toEqual(['main.tex', ...kept.map((k) => k.path)].sort());
  expect(report.skipped).toEqual(
    svgs.map((s) => ({
      path: s.path,
      reason: 'LaTeX cannot use this picture as it is: convert it to PDF or PNG',
    })),
  );
  // The text types open as text; the fonts are bytes.
  const byPath = new Map(report.files.map((f) => [f.path, f]));
  expect(byPath.get('x.tikz')).toEqual({ path: 'x.tikz' });
  expect(byPath.get('x.ttf')).toEqual({ path: 'x.ttf', readonly: 'binary' });
});

test('a .tar.gz, a .tar and a .gz are refused with a sentence that says what to do', async () => {
  const tar = Buffer.alloc(1024);
  tar.write('paper/main.tex');
  tar.write('ustar', 257);
  expect(await refused(gzipSync(tar))).toBe(
    'invalid_input: This is a .tar.gz, as arXiv gives. Unpack it and make a ZIP of the folder, then import that.',
  );
  expect(await refused(gzipSync(Buffer.from(doc())))).toBe(
    'invalid_input: This is a .gz, one compressed file. Unpack it and put it in a ZIP with the rest of the paper, then import that.',
  );
  expect(await refused(tar)).toBe(
    'invalid_input: This is a .tar, not a ZIP. Unpack it and make a ZIP of the folder, then import that.',
  );
});

test('an archive with no root says what a root is; a Latin-1 root says what is wrong with it', async () => {
  const noRoot =
    'invalid_input: No file here has \\begin{document} with a \\documentclass before it, in that file or in a file it \\inputs.';
  expect(
    await refused(
      await writeZip([file('main.tex', '\\documentclass{article}\n'), file('b.tex', 'text')]),
    ),
  ).toBe(noRoot);
  const latin = Buffer.from(doc('Caf\u00e9', '\\usepackage[latin1]{inputenc}\n'), 'latin1');
  expect(await refused(await writeZip([file('paper/main.tex', latin)]))).toBe(
    "invalid_input: This ZIP cannot be imported: paper/main.tex is the paper's main file, but it is not UTF-8 text (it may be Latin-1). Save it as UTF-8, change \\usepackage[latin1]{inputenc} to utf8, and import again.",
  );
  // A Latin-1 file that is not a root is no reason for that sentence.
  expect(
    await refused(
      await writeZip([file('x.tex', Buffer.from('Caf\u00e9', 'latin1')), file('y.tex', 'y')]),
    ),
  ).toBe(noRoot);
  // A UTF-8 root with a Latin-1 file it includes is still imported, with that file read-only.
  const { report } = await reportOf(owner.id, [
    file('main.tex', doc('\\input{lat}')),
    file('lat.tex', Buffer.from('Caf\u00e9', 'latin1')),
  ]);
  expect(report.files.find((f) => f.path === 'lat.tex')).toEqual({
    path: 'lat.tex',
    readonly: 'not-utf8',
  });
});

test('of several files that could be the paper, the one that brings in the others is it', async () => {
  const { report } = await reportOf(owner.id, [
    file('cover-letter.tex', doc('Dear editor, we send you our paper. '.repeat(5))),
    file('paper.tex', doc('\\input{sections/a}\\input{sections/b}')),
    file('sections/a.tex', 'A'),
    file('sections/b.tex', 'B'),
  ]);
  expect(report.root).toBe('paper.tex');
  expect(report.otherRoots).toEqual(['cover-letter.tex']);
  // "main." in the name still comes before anything reached, and depth before that.
  const named = await reportOf(owner.id, [
    file('main.tex', doc('x')),
    file('paper.tex', doc('\\input{a}\\input{b}')),
    file('a.tex', 'A'),
    file('b.tex', 'B'),
  ]);
  expect(named.report.root).toBe('main.tex');
  // With nothing to tell them apart by reach, the name decides, not the length.
  const plain = await reportOf(owner.id, [
    file('paper.tex', doc('PAPER BODY')),
    file('response-to-reviewers.tex', doc('RESPONSE BODY, which is the longer of the two')),
  ]);
  expect(plain.report.root).toBe('paper.tex');
  expect(plain.report.otherRoots).toEqual(['response-to-reviewers.tex']);
});

test('a paper that is alone is named after its ZIP, several keep their folders', async () => {
  const wrapped = await reportOf(
    owner.id,
    [file('src/main.tex', doc()), file('notes.md', 'n')],
    'My ZIP',
  );
  expect(wrapped.made.map((p) => p.name)).toEqual(['My ZIP']);
  const folder = await reportOf(owner.id, [file('Thesis draft/main.tex', doc())], 'thesis-zip');
  expect(folder.made.map((p) => p.name)).toEqual(['thesis-zip']);
  // No name for the ZIP: the folder's.
  expect((await reportOf(owner.id, [file('Thesis draft/main.tex', doc())], '')).made[0].name).toBe(
    'Thesis draft',
  );
  const several = await reportOf(owner.id, [file('a/main.tex', doc()), file('b/main.tex', doc())]);
  expect(several.made.map((p) => p.name)).toEqual(['a', 'b']);
});

async function buildOf(project: string) {
  const dir = mkdtempSync(join(tmpdir(), 'paperweave-src-'));
  for (const e of (await readZip(await exportZip(t.pool, store, owner.id, project))).entries) {
    mkdirSync(dirname(join(dir, e.path)), { recursive: true });
    writeFileSync(join(dir, e.path), e.bytes);
  }
  const r = await compile(dir, 'main.tex', join(dir, '__out'), 120);
  return r.ok ? 'ok' : r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
}

test('program source and data files are kept, build, and survive an export and a re-import', async () => {
  const main = [
    '\\documentclass{article}',
    '\\usepackage{listings}',
    '\\begin{document}',
    '\\lstinputlisting[language=Python]{code/a.py}',
    '\\end{document}',
    '',
  ].join('\n');
  const py = Buffer.from('print("hi")\nx = 1\n');
  const sources = ['src/x.c', 'Main.java', 'fit.m', 'plot.R', 'cfg.json'];
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(main) },
    { path: 'code/a.py', bytes: py },
    ...sources.map((path) => ({ path, bytes: Buffer.from('// ' + path + '\n') })),
    { path: 'notes.docx', bytes: Buffer.from('PK') },
    { path: 'a.exe', bytes: Buffer.from('MZ') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Sources');
  const report = (await importReport(t.pool, owner.id, project.id))!;
  expect(report.skipped.map((s) => s.path).sort()).toEqual(['a.exe', 'notes.docx']);
  expect(report.files.map((f) => f.path).sort()).toEqual(
    ['main.tex', 'code/a.py', ...sources].sort(),
  );
  // Text, so editable: no read-only mark on any of them.
  for (const f of report.files) expect(f, f.path).not.toHaveProperty('readonly');
  expect(await buildOf(project.id)).toBe('ok');

  // The export holds the source byte for byte, and a file PaperWeave itself writes.
  const out = await readZip(await exportZip(t.pool, store, owner.id, project.id));
  expect(Buffer.from(out.entries.find((e) => e.path === 'code/a.py')!.bytes).equals(py)).toBe(true);

  // A revision's download also holds PaperWeave's own file; reading it back skips it.
  await saveRevision(t.pool, store, owner.id, project.id, 'first');
  const [{ id: revision }] = (await listRevisions(t.pool, owner.id, project.id)) as unknown as {
    id: string;
  }[];
  const raw = (await exportRevision(t.pool, store, owner.id, project.id, revision, true)).zip;
  const read = await readZip(raw);
  expect(read.skipped).toEqual([
    { path: 'paperweave-toolchain.json', reason: 'written by PaperWeave on download' },
  ]);
  const [again] = await importZip(t.pool, store, owner.id, raw, 'Again');
  await saveRevision(t.pool, store, owner.id, again.id, 'again');
  const [{ id: revision2 }] = (await listRevisions(t.pool, owner.id, again.id)) as unknown as {
    id: string;
  }[];
  const second = await readZip(
    (await exportRevision(t.pool, store, owner.id, again.id, revision2, true)).zip,
  );
  expect(second.skipped.filter((s) => s.path === 'paperweave-toolchain.json')).toHaveLength(1);
  expect(Buffer.from(second.entries.find((e) => e.path === 'code/a.py')!.bytes).equals(py)).toBe(
    true,
  );
  expect(second.entries.map((e) => e.path).sort()).toEqual(out.entries.map((e) => e.path).sort());

  // The name belongs to PaperWeave.
  await expect(
    createFile(t.pool, store, owner.id, again.id, 'paperweave-toolchain.json'),
  ).rejects.toThrow(/written by PaperWeave on download/);
});

test('source files that are not UTF-8 text, or hold NUL bytes, are kept but read-only', async () => {
  const zip = await writeZip([
    {
      path: 'main.tex',
      bytes: Buffer.from('\\documentclass{article}\\begin{document}x\\end{document}\n'),
    },
    { path: 'latin.py', bytes: Buffer.from([0x63, 0xe9, 0x0a]) },
    { path: 'nul.c', bytes: Buffer.from([0x61, 0, 0x62]) },
    { path: 'ok.py', bytes: Buffer.from('x = 1\n') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Odd');
  const report = (await importReport(t.pool, owner.id, project.id))!;
  const by = new Map(report.files.map((f) => [f.path, f]));
  expect(by.get('latin.py')).toEqual({ path: 'latin.py', readonly: 'not-utf8' });
  expect(by.get('nul.c')).toEqual({ path: 'nul.c', readonly: 'not-utf8' });
  expect(by.get('ok.py')).toEqual({ path: 'ok.py' });
});

test('a \\documentclass that lives in an \\input-ed file still makes the paper importable', async () => {
  const body = '\\begin{document}\nHello.\n\\end{document}\n';
  const plain = await reportOf(owner.id, [
    file('main.tex', `\\input{setup}\n${body}`),
    file('setup.tex', '\\documentclass{article}\n'),
  ]);
  expect(plain.report.root).toBe('main.tex');
  expect(plain.report.files.find((f) => f.path === 'setup.tex')).toMatchObject({
    sourceOnly: true,
  });
  expect(plain.report.compiler).toBe('pdflatex');
  expect(plain.report.missing).toEqual([]);
  // The engine comes from what the preamble file loads.
  const xe = await reportOf(owner.id, [
    file('main.tex', `\\input{setup}\n${body}`),
    file('setup.tex', '\\documentclass{article}\n\\usepackage{fontspec}\n'),
  ]);
  expect(xe.report.compiler).toBe('xelatex');
  // In a wrapping folder, and in a subfolder.
  const wrapped = await reportOf(owner.id, [
    file('paper/main.tex', `\\input{tex/setup}\n${body}`),
    file('paper/tex/setup.tex', '\\documentclass{article}\n'),
  ]);
  expect(wrapped.report.root).toBe('main.tex');
  expect(wrapped.paths).toEqual(['main.tex', 'tex/setup.tex']);
  expect(wrapped.report.files.find((f) => f.path === 'tex/setup.tex')).toMatchObject({
    sourceOnly: true,
  });
  // No \documentclass anywhere is still refused.
  expect(
    await refused(
      await writeZip([file('main.tex', `\\input{setup}\n${body}`), file('setup.tex', 'x')]),
    ),
  ).toContain('with a \\documentclass before it');
});
