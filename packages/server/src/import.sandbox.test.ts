// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type Entry, LIMITS, readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { exportZip, importReport, importZip, listFiles } from './import.ts';
import { acceptInvitation, createProject, invite, listProjects } from './projects.ts';
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
  // The wrapping folder becomes the paper's name and is taken off every path.
  expect(project.name).toBe('My Paper');
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
