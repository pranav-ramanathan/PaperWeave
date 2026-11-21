// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { compile } from '../../../apps/workers/src/compile.ts';
import { LIMITS, readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import {
  createFile,
  deleteFile,
  picture,
  pictureDigest,
  pictures,
  proposeFileRename,
  renameFileAndReferences,
  setRootFile,
} from './files.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { acceptInvitation, createProject, getProject, invite, setRole } from './projects.ts';
import { listRevisions, renameFile, restoreRevision, saveRevision } from './revisions.ts';
import { editFile, openFile } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
const MAIN = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
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

async function paper() {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: 'intro.tex', bytes: Buffer.from('Intro text.\n') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Files');
  const { token } = await invite(t.pool, owner.id, project.id, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  return { id: project.id, main: ids['main.tex'], intro: ids['intro.tex'] };
}
const paths = async (project: string) =>
  (await listFiles(t.pool, owner.id, project)).map((f) => f.path);
const content = async (project: string) =>
  Object.fromEntries(
    (await readZip(await exportZip(t.pool, store, owner.id, project))).entries.map((e) => [
      e.path,
      Buffer.from(e.bytes).toString('latin1'),
    ]),
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test('a blank text file and an uploaded file can be added, edited and exported', async () => {
  const p = await paper();
  const notes = await createFile(t.pool, store, owner.id, p.id, 'sections/notes.tex');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
  await createFile(t.pool, store, owner.id, p.id, 'figures/plot.png', png);
  const crlf = await createFile(
    t.pool,
    store,
    owner.id,
    p.id,
    'table.csv',
    Buffer.from('a,b\r\n1,2\r\n'),
  );
  expect(await paths(p.id)).toEqual([
    'figures/plot.png',
    'intro.tex',
    'main.tex',
    'sections/notes.tex',
    'table.csv',
  ]);

  // The new text file opens for live editing like any other; the image does not.
  expect((await openFile(t.pool, owner.id, notes)).canWrite).toBe(true);
  await editFile(t.pool, store, notes, owner.id, (text) => text.insert(0, 'First note.\n'));
  await editFile(t.pool, store, crlf, owner.id, (text) => text.insert(text.length, '3,4\n'));
  const out = await content(p.id);
  expect(out['sections/notes.tex']).toBe('First note.\n');
  expect(out['figures/plot.png']).toBe(png.toString('latin1'));
  // An uploaded text file keeps the line endings it came with.
  expect(out['table.csv']).toBe('a,b\r\n1,2\r\n3,4\r\n');
});

test('bad names, duplicates and people without write access are refused', async () => {
  const p = await paper();
  expect(await code(createFile(t.pool, store, owner.id, p.id, 'intro.tex'))).toBe('conflict');
  for (const bad of [
    '../x.tex',
    '/etc/x.tex',
    'a/../b.tex',
    'tool.exe',
    'latexmkrc',
    '',
    'main.aux',
  ])
    expect(await code(createFile(t.pool, store, owner.id, p.id, bad)), JSON.stringify(bad)).toBe(
      'invalid_input',
    );
  expect(await code(createFile(t.pool, store, viewer.id, p.id, 'ok.tex'))).toBe(
    'permission_denied',
  );
  expect(await code(createFile(t.pool, store, outsider.id, p.id, 'ok.tex'))).toBe('not_found');
  expect(await code(deleteFile(t.pool, store, viewer.id, p.id, p.intro))).toBe('permission_denied');
  expect(await code(deleteFile(t.pool, store, outsider.id, p.id, p.intro))).toBe('not_found');
  // A file of another paper cannot be deleted or made root through this one.
  const other = await paper();
  expect(await code(deleteFile(t.pool, store, owner.id, p.id, other.intro))).toBe('not_found');
  expect(await code(setRootFile(t.pool, owner.id, p.id, other.main))).toBe('invalid_input');
  expect(await paths(p.id)).toEqual(['intro.tex', 'main.tex']);
});

test('a paper takes only so many files, and only so much in all', async () => {
  const p = await paper();
  // The paper has two files already. The limits here are small ones: room for 27 bytes more.
  const have = MAIN.length + 'Intro text.\n'.length;
  const limits = { ...LIMITS, files: 4, totalBytes: have + 27, fileBytes: 40 };
  const add = (path: string, size: number) =>
    createFile(t.pool, store, owner.id, p.id, path, Buffer.alloc(size, 'x'), limits);
  await expect(add('one-file-too-large.txt', 41)).rejects.toThrow('That file is too large.');
  await expect(add('too-much-in-all.txt', 28)).rejects.toThrow('This paper is full');
  await add('fits.txt', 27);
  await add('empty.txt', 0);
  await expect(add('a-fifth.txt', 0)).rejects.toThrow('This paper has too many files.');
  expect(await paths(p.id)).toEqual(['empty.txt', 'fits.txt', 'intro.tex', 'main.tex']);
});

test('the root file is protected, and another .tex file can take its place', async () => {
  const p = await paper();
  expect(await code(deleteFile(t.pool, store, owner.id, p.id, p.main))).toBe('invalid_input');
  const png = await createFile(t.pool, store, owner.id, p.id, 'fig.png', Buffer.from([1, 2, 3]));
  expect(await code(setRootFile(t.pool, owner.id, p.id, png))).toBe('invalid_input');
  expect(await code(setRootFile(t.pool, viewer.id, p.id, p.intro))).toBe('permission_denied');
  await setRootFile(t.pool, owner.id, p.id, p.intro);
  expect((await getProject(t.pool, owner.id, p.id)).root).toBe('intro.tex');
  await deleteFile(t.pool, store, owner.id, p.id, p.main);
  expect(await paths(p.id)).toEqual(['fig.png', 'intro.tex']);
});

test('the first .tex file of an empty paper becomes its root', async () => {
  const { id } = await createProject(t.pool, owner.id, 'From scratch');
  await createFile(t.pool, store, owner.id, id, 'refs.bib');
  expect((await getProject(t.pool, owner.id, id)).root).toBeNull();
  await createFile(t.pool, store, owner.id, id, 'paper.tex', Buffer.from(MAIN));
  await createFile(t.pool, store, owner.id, id, 'appendix.tex');
  expect((await getProject(t.pool, owner.id, id)).root).toBe('paper.tex');
});

test('two people adding the same name at once: one succeeds', async () => {
  const p = await paper();
  const both = await Promise.all(
    [1, 2].map(() => code(createFile(t.pool, store, owner.id, p.id, 'same.tex'))),
  );
  expect(both.sort()).toEqual(['conflict', 'ok']);
});

test('a deleted file is saved first, and restoring brings back the same file', async () => {
  const p = await paper();
  await editFile(t.pool, store, p.intro, owner.id, (text) => text.insert(0, 'Edited. '));
  await deleteFile(t.pool, store, owner.id, p.id, p.intro);
  expect(await paths(p.id)).toEqual(['main.tex']);
  expect(await code(openFile(t.pool, owner.id, p.intro))).toBe('not_found');
  // Deleting cut a revision that still holds the file as it was, edit included.
  const [saved] = await listRevisions(t.pool, owner.id, p.id);
  expect(saved).toMatchObject({ number: 1, kind: 'auto' });

  // Meanwhile a new file appears and takes the old name.
  await createFile(t.pool, store, owner.id, p.id, 'intro.tex', Buffer.from('An impostor.\n'));
  await createFile(t.pool, store, owner.id, p.id, 'extra.tex');
  await restoreRevision(t.pool, store, owner.id, p.id, saved.id);
  const back = await listFiles(t.pool, owner.id, p.id);
  expect(back.map((f) => f.path)).toEqual(['intro.tex', 'main.tex']);
  // It is the original file again, not the impostor, and it can be edited.
  expect(back.find((f) => f.path === 'intro.tex')!.id).toBe(p.intro);
  expect((await content(p.id))['intro.tex']).toBe('Edited. Intro text.\n');
  await editFile(t.pool, store, p.intro, owner.id, (text) => text.insert(0, 'Again. '));
  expect((await content(p.id))['intro.tex']).toBe('Again. Edited. Intro text.\n');
});

/**
 * The pool, running `act` once, just before the first statement of a transaction that comes after
 * its `for update` on the files, and waiting for it. The delete holds every file row there.
 */
function holdingFiles(act: () => Promise<void>) {
  let locked = false;
  let acted = false;
  const pool = t.pool;
  return new Proxy(pool, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop !== 'connect') return typeof v === 'function' ? v.bind(target) : v;
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(c, p) {
            const w = Reflect.get(c, p);
            if (p !== 'query') return typeof w === 'function' ? w.bind(c) : w;
            return async (sql: string, params?: unknown[]) => {
              if (locked && !acted) {
                acted = true;
                await act();
              }
              if (/for update/.test(sql)) locked = true;
              return c.query(sql, params);
            };
          },
        });
      };
    },
  });
}
/** Wait until some other connection is waiting on a lock held by this database's others. */
async function untilSomeoneWaits() {
  for (let i = 0; i < 400; i++) {
    const { rowCount } = await t.pool.query(
      `select 1 from pg_stat_activity where datname = current_database()
       and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if (rowCount) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nobody started waiting for the files');
}

test('typing that queues behind a delete is refused, and the revision holds all that was acknowledged', async () => {
  const p = await paper();
  await editFile(t.pool, store, p.intro, owner.id, (text) => text.insert(0, 'Edited. '));
  let late!: Promise<string>;
  const deleting = deleteFile(
    holdingFiles(async () => {
      late = code(editFile(t.pool, store, p.intro, owner.id, (text) => text.insert(0, 'LATE ')));
      await untilSomeoneWaits();
    }),
    store,
    owner.id,
    p.id,
    p.intro,
  );
  const { revision } = await deleting;
  // The edit was never acknowledged, so nothing is promised that the revision lacks.
  expect(await late).toBe('not_found');
  const seqs = await t.pool.query(
    `select f.head_seq, rf.seq from all_files f join revision_files rf on rf.file_id = f.id
     join revisions r on r.id = rf.revision_id where f.id = $1 and r.project_id = $2 and r.number = $3`,
    [p.intro, p.id, revision],
  );
  expect(seqs.rows).toHaveLength(1);
  expect(String(seqs.rows[0].head_seq)).toBe(String(seqs.rows[0].seq));
  const [saved] = await listRevisions(t.pool, owner.id, p.id);
  await restoreRevision(t.pool, store, owner.id, p.id, saved.id);
  expect((await content(p.id))['intro.tex']).toBe('Edited. Intro text.\n');
});

test('a person whose role is lowered while their delete waits is refused, and the file stays', async () => {
  const p = await paper();
  const second = await t.signIn('second-editor@example.org');
  const { token } = await invite(t.pool, owner.id, p.id, second.email, 'editor');
  await acceptInvitation(t.pool, second.id, token);
  const deleting = deleteFile(
    holdingFiles(() => setRole(t.pool, owner.id, p.id, second.id, 'viewer')),
    store,
    second.id,
    p.id,
    p.intro,
  );
  expect(await code(deleting)).toBe('permission_denied');
  expect(await paths(p.id)).toEqual(['intro.tex', 'main.tex']);
});

test('restoring a revision can swap two files back to their old names', async () => {
  const p = await paper();
  const before = await saveRevision(t.pool, store, owner.id, p.id, 'Before the swap');
  await renameFile(t.pool, owner.id, p.id, p.intro, 'tmp.tex');
  await renameFile(t.pool, owner.id, p.id, p.main, 'intro.tex');
  await renameFile(t.pool, owner.id, p.id, p.intro, 'main.tex');
  expect((await content(p.id))['main.tex']).toBe('Intro text.\n');
  await restoreRevision(t.pool, store, owner.id, p.id, before.id);
  const now = await content(p.id);
  expect(now['main.tex']).toBe(MAIN);
  expect(now['intro.tex']).toBe('Intro text.\n');
});

const NAMED = {
  'main.tex': [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\input{sections/intro} % was \\input{sections/intro}',
    '\\include{sections/method.tex}',
    '\\includegraphics[width=1cm]{figures/plot} and \\includegraphics{figures/plot.png}',
    '\\bibliography{refs, more}',
    '\\end{document}',
    '',
  ].join('\r\n'),
  'sections/intro.tex': 'Intro.\n',
  'sections/method.tex': 'Method, see \\input{sections/intro}.\n',
  'refs.bib': '',
  'more.bib': '',
  'notes.txt': 'Nobody includes this.\n',
};
async function named() {
  const zip = await writeZip([
    ...Object.entries(NAMED).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
    { path: 'figures/plot.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Named');
  const { token } = await invite(t.pool, owner.id, project.id, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  return { id: project.id, ids };
}

test('renaming a file shows the lines that name it, and changes them with it', async () => {
  const p = await named();
  const rename = async (from: string, to: string) => {
    const proposal = await proposeFileRename(t.pool, store, owner.id, p.id, p.ids[from], to);
    const done = await renameFileAndReferences(
      t.pool,
      store,
      owner.id,
      p.id,
      p.ids[from],
      to,
      proposal.digest,
    );
    return { lines: proposal.changes.map((c) => `${c.path}:${c.line} ${c.after}`), ...done };
  };
  // Written without its extension, and still is. The commented-out line is left alone.
  expect(await rename('sections/intro.tex', 'parts/introduction.tex')).toEqual({
    lines: [
      'main.tex:3 \\input{parts/introduction} % was \\input{sections/intro}',
      'sections/method.tex:1 Method, see \\input{parts/introduction}.',
    ],
    places: 2,
  });
  // Written with its extension, and still is.
  expect((await rename('sections/method.tex', 'sections/design.tex')).lines).toEqual([
    'main.tex:4 \\include{sections/design.tex}',
  ]);
  // An image named twice on one line, once with and once without its extension.
  expect(await rename('figures/plot.png', 'figures/latency.png')).toEqual({
    lines: [
      'main.tex:5 \\includegraphics[width=1cm]{figures/latency} and \\includegraphics{figures/latency.png}',
    ],
    places: 2,
  });
  // One of two names in a list.
  expect((await rename('refs.bib', 'bib/refs.bib')).lines).toEqual([
    'main.tex:6 \\bibliography{bib/refs, more}',
  ]);
  // A file nothing names is simply renamed.
  expect(await rename('notes.txt', 'docs/notes.txt')).toEqual({ lines: [], places: 0 });

  const files = await listFiles(t.pool, owner.id, p.id);
  expect(files.map((f) => f.path)).toEqual([
    ...['bib/refs.bib', 'docs/notes.txt', 'figures/latency.png', 'main.tex', 'more.bib'],
    ...['parts/introduction.tex', 'sections/design.tex'],
  ]);
  // Each is the same file under a new name.
  expect(files.find((f) => f.path === 'parts/introduction.tex')!.id).toBe(
    p.ids['sections/intro.tex'],
  );
  // Only the names changed: every other byte of main.tex, its line ends included, is as it was.
  expect((await content(p.id))['main.tex']).toBe(
    NAMED['main.tex']
      .replace('\\input{sections/intro} %', '\\input{parts/introduction} %')
      .replace('sections/method.tex', 'sections/design.tex')
      .replaceAll('figures/plot', 'figures/latency')
      .replace('{refs, more}', '{bib/refs, more}'),
  );
});

test('a file named in two groups of \\import is renamed group by group', async () => {
  const zip = await writeZip(
    Object.entries({
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\import{sections/}{method} and \\subimport{sections}{results}',
        '\\end{document}',
        '',
      ].join('\n'),
      'sections/method.tex': 'Method.\n',
      'sections/results.tex': 'Results.\n',
    }).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Imported');
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  const rename = async (from: string, to: string) => {
    const proposal = await proposeFileRename(t.pool, store, owner.id, project.id, ids[from], to);
    await renameFileAndReferences(
      t.pool,
      store,
      owner.id,
      project.id,
      ids[from],
      to,
      proposal.digest,
    );
    return proposal.changes.map((c) => `${c.path}:${c.line} ${c.after}`);
  };
  // Only the file group changes when the folder is the same; the folder keeps its slash style.
  expect(await rename('sections/method.tex', 'sections/approach.tex')).toEqual([
    'main.tex:3 \\import{sections/}{approach} and \\subimport{sections}{results}',
  ]);
  expect(await rename('sections/results.tex', 'parts/results.tex')).toEqual([
    'main.tex:3 \\import{sections/}{approach} and \\subimport{parts}{results}',
  ]);
  expect((await content(project.id))['main.tex']).toContain(
    '\\import{sections/}{approach} and \\subimport{parts}{results}',
  );
});

test('a file rename is refused whole when the lines have changed, and can leave them alone when asked', async () => {
  const p = await named();
  const intro = p.ids['sections/intro.tex'];
  const proposal = await proposeFileRename(t.pool, store, owner.id, p.id, intro, 'intro.tex');
  await editFile(t.pool, store, p.ids['main.tex'], owner.id, (text) =>
    text.insert(text.toString().indexOf('\\bibliography'), '\\input{sections/intro}\n'),
  );
  const before = await content(p.id);
  const go = (who: string, file: string, to: unknown, digest?: unknown) =>
    code(renameFileAndReferences(t.pool, store, who, p.id, file, to, digest));
  expect(await go(owner.id, intro, 'intro.tex', proposal.digest)).toBe('conflict');
  expect(await go(owner.id, intro, 'main.tex', proposal.digest)).toBe('conflict');
  expect(await go(owner.id, intro, '../intro.tex', proposal.digest)).toBe('invalid_input');
  expect(await go(viewer.id, intro, 'intro.tex', proposal.digest)).toBe('permission_denied');
  expect(await go(outsider.id, intro, 'intro.tex', proposal.digest)).toBe('not_found');
  const other = await named();
  expect(await go(owner.id, other.ids['main.tex'], 'x.tex', proposal.digest)).toBe('not_found');
  expect(await code(proposeFileRename(t.pool, store, owner.id, p.id, intro, 'main.tex'))).toBe(
    'conflict',
  );
  expect(await code(proposeFileRename(t.pool, store, viewer.id, p.id, intro, 'i.tex'))).toBe(
    'permission_denied',
  );
  // Nothing happened: not the name, not a line.
  expect(await content(p.id)).toEqual(before);

  // Without a digest only the name changes, and the lines still say the old one.
  expect(await go(owner.id, intro, 'intro.tex')).toBe('ok');
  const after = await content(p.id);
  expect(after['intro.tex']).toBe('Intro.\n');
  expect(after['main.tex']).toBe(before['main.tex']);
});

// A small valid PNG: a black square on white.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAAFklEQVR4nGP4DwUMSAwGBgYGQgw0XQC54i/RD0GiIwAAAABJRU5ErkJggg==',
  'base64',
);

test('a picture is served as LaTeX would find it, and only if a browser can show it', async () => {
  const zip = await writeZip([
    { path: 'paper/main.tex', bytes: Buffer.from(MAIN) },
    { path: 'paper/figures/dot.png', bytes: PNG },
    { path: 'paper/figures/plot.pdf', bytes: Buffer.from('%PDF-1.4') },
    { path: 'paper/photo.JPG', bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Pictures');
  const get = (who: string, target: string) => picture(t.pool, store, who, project.id, target);
  // With or without its extension, as \includegraphics allows.
  for (const target of ['figures/dot', 'figures/dot.png', './figures/dot']) {
    const found = await get(owner.id, target);
    expect(found.type, target).toBe('image/png');
    expect(Buffer.from(found.bytes).equals(PNG), target).toBe(true);
  }
  expect((await get(owner.id, 'photo')).type).toBe('image/jpeg');
  // The lookup alone gives the stored version's digest, and the same refusals.
  const sha = createHash('sha256').update(PNG).digest('hex');
  for (const target of ['figures/dot', 'figures/dot.png', './figures/dot'])
    expect(await pictureDigest(t.pool, store, owner.id, project.id, target), target).toMatchObject({
      digest: sha,
      type: 'image/png',
    });
  expect(await code(pictureDigest(t.pool, store, outsider.id, project.id, 'figures/dot'))).toBe(
    'not_found',
  );
  expect(await code(pictureDigest(t.pool, store, owner.id, project.id, 'figures/plot'))).toBe(
    'not_found',
  );
  // A PDF figure is real, but not something to hand a browser as a picture. Nor is anything
  // that is not a picture, or not there, or outside the paper.
  for (const target of [
    'figures/plot',
    'figures/plot.pdf',
    'main.tex',
    'nothing',
    '../../etc/passwd',
    '\\figs/dot',
  ])
    expect(await code(get(owner.id, target)), target).toBe('not_found');
  expect(await code(get(outsider.id, 'figures/dot'))).toBe('not_found');

  expect(await pictures(t.pool, owner.id, project.id)).toEqual([
    { path: 'figures/dot.png', target: 'figures/dot.png' },
    { path: 'figures/plot.pdf', target: 'figures/plot.pdf' },
    { path: 'photo.JPG', target: 'photo.JPG' },
  ]);
  expect(await code(pictures(t.pool, outsider.id, project.id))).toBe('not_found');
});

const GP = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\graphicspath{{figures/}}',
  '\\begin{document}',
  '\\includegraphics[width=1cm]{plot}',
  '\\end{document}',
  '',
].join('\n');

async function buildsFine(project: string) {
  const dir = mkdtempSync(join(tmpdir(), 'paperweave-gp-'));
  for (const e of (await readZip(await exportZip(t.pool, store, owner.id, project))).entries) {
    mkdirSync(dirname(join(dir, e.path)), { recursive: true });
    writeFileSync(join(dir, e.path), e.bytes);
  }
  const r = await compile(dir, 'main.tex', join(dir, '__out'), 120);
  return r.ok ? 'ok' : r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
}

test('a picture under \\graphicspath is found, and renaming it keeps the paper building', async () => {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(GP) },
    { path: 'figures/plot.png', bytes: PNG },
    { path: 'styles/mine.sty', bytes: Buffer.from('\\ProvidesPackage{mine}\n') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Graphicspath');
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  expect((await picture(t.pool, store, owner.id, project.id, 'plot')).path).toBe(
    'figures/plot.png',
  );
  expect(await buildsFine(project.id)).toBe('ok');

  // No \\usepackage names this package: a rename has no line to change, and no surprise.
  const sty = await proposeFileRename(
    t.pool,
    store,
    owner.id,
    project.id,
    ids['styles/mine.sty'],
    'mine.sty',
  );
  expect(sty.changes).toEqual([]);

  // Still in the folder: the name is relative to it.
  const plot = ids['figures/plot.png'];
  const move = async (to: string) => {
    const proposal = await proposeFileRename(t.pool, store, owner.id, project.id, plot, to);
    await renameFileAndReferences(t.pool, store, owner.id, project.id, plot, to, proposal.digest);
    return proposal.changes.map((c) => c.after);
  };
  expect(await move('figures/latency.png')).toEqual(['\\includegraphics[width=1cm]{latency}']);
  expect(await buildsFine(project.id)).toBe('ok');
  // Out of the folder: relative to the root's folder instead.
  expect(await move('img/plot.png')).toEqual(['\\includegraphics[width=1cm]{img/plot}']);
  expect(await buildsFine(project.id)).toBe('ok');
});

const SUPPORT = [
  '\\documentclass{article}',
  '\\usepackage{amsmath,styles/mine}',
  '\\usepackage{listings,pgfplots,csvsimple}',
  '\\pgfplotsset{compat=1.17}',
  '\\begin{document}',
  '\\lstinputlisting{code/a.txt}',
  '\\begin{tikzpicture}\\begin{axis}\\addplot table[col sep=comma,x=a,y=b]{data.csv};\\end{axis}\\end{tikzpicture}',
  '\\csvautotabular{data.csv}',
  '\\mineword',
  '\\end{document}',
  '',
].join('\n');

test('renaming a style, a listing and a data file follows the lines that name them, and the paper builds', async () => {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(SUPPORT) },
    {
      path: 'styles/mine.sty',
      bytes: Buffer.from('\\ProvidesPackage{mine}\n\\newcommand{\\mineword}{styled}\n'),
    },
    { path: 'code/a.txt', bytes: Buffer.from('listing line\n') },
    { path: 'data.csv', bytes: Buffer.from('a,b\n1,2\n2,3\n') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Support');
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  expect(await buildsFine(project.id)).toBe('ok');
  const rename = async (from: string, to: string) => {
    const proposal = await proposeFileRename(t.pool, store, owner.id, project.id, ids[from], to);
    await renameFileAndReferences(
      t.pool,
      store,
      owner.id,
      project.id,
      ids[from],
      to,
      proposal.digest,
    );
    return proposal.changes.map((c) => `${c.line} ${c.after}`);
  };
  // Only the one name in the list changes, and the extension is left off.
  expect(await rename('styles/mine.sty', 'sty/theirs.sty')).toEqual([
    '2 \\usepackage{amsmath,sty/theirs}',
  ]);
  expect(await buildsFine(project.id)).toBe('ok');
  expect(await rename('code/a.txt', 'listings/b.txt')).toEqual([
    '6 \\lstinputlisting{listings/b.txt}',
  ]);
  expect(await buildsFine(project.id)).toBe('ok');
  expect((await rename('data.csv', 'data/d.csv')).map((l) => l.replace(/ %.*/, ''))).toEqual([
    '7 \\begin{tikzpicture}\\begin{axis}\\addplot table[col sep=comma,x=a,y=b]{data/d.csv};\\end{axis}\\end{tikzpicture}',
    '8 \\csvautotabular{data/d.csv}',
  ]);
  expect(await buildsFine(project.id)).toBe('ok');
});

test('a file reached through \\import is renamed in the lines of the imported files', async () => {
  const zip = await writeZip(
    Object.entries({
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\import{sections/}{intro}',
        '\\input{top}',
        '\\end{document}',
        '',
      ].join('\n'),
      'sections/intro.tex': '\\subimport{figs/}{plot}\n\\input{detail}\n',
      'sections/figs/plot.tex': 'Plot.\n',
      'sections/detail.tex': 'Detail.\n',
      'top.tex': 'Top.\n',
    }).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Imported');
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  const propose = async (from: string, to: string) =>
    (await proposeFileRename(t.pool, store, owner.id, project.id, ids[from], to)).changes.map(
      (c) => `${c.path}:${c.line} ${c.after}`,
    );
  expect(await propose('sections/figs/plot.tex', 'sections/figs/plot2.tex')).toEqual([
    'sections/intro.tex:1 \\subimport{figs/}{plot2}',
  ]);
  expect(await propose('sections/figs/plot.tex', 'sections/other/plot.tex')).toEqual([
    'sections/intro.tex:1 \\subimport{other/}{plot}',
  ]);
  expect(await propose('sections/detail.tex', 'sections/detail2.tex')).toEqual([
    'sections/intro.tex:2 \\input{detail2}',
  ]);
  // Out of the import folder: named from the root, which TeX falls back to.
  expect(await propose('sections/detail.tex', 'parts/detail.tex')).toEqual([
    'sections/intro.tex:2 \\input{parts/detail}',
  ]);
  // A root-level include is as before.
  expect(await propose('top.tex', 'sections/top.tex')).toEqual([
    'main.tex:4 \\input{sections/top}',
  ]);
});

test('a source file can be added as text, and renaming a listing to .py keeps the paper building', async () => {
  const main = SUPPORT.replace('code/a.txt', 'code/a.txt');
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(main) },
    {
      path: 'styles/mine.sty',
      bytes: Buffer.from('\\ProvidesPackage{mine}\n\\newcommand{\\mineword}{styled}\n'),
    },
    { path: 'code/a.txt', bytes: Buffer.from('listing line\n') },
    { path: 'data.csv', bytes: Buffer.from('a,b\n1,2\n2,3\n') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Source');
  const b = await createFile(t.pool, store, owner.id, project.id, 'code/b.py');
  expect((await openFile(t.pool, owner.id, b)).canWrite).toBe(true);
  const row = await t.pool.query('select readonly_reason from files where id = $1', [b]);
  expect(row.rows[0].readonly_reason).toBeNull();
  await expect(
    createFile(t.pool, store, owner.id, project.id, 'paperweave-toolchain.json'),
  ).rejects.toThrow(/written by PaperWeave on download/);
  // Not UTF-8, or with NUL bytes: stored as bytes, not edited.
  const latin = await createFile(
    t.pool,
    store,
    owner.id,
    project.id,
    'l.py',
    Buffer.from([0x63, 0xe9]),
  );
  const nul = await createFile(
    t.pool,
    store,
    owner.id,
    project.id,
    'n.c',
    Buffer.from([0x61, 0, 0x62]),
  );
  const marks = await t.pool.query('select readonly_reason from files where id = any($1)', [
    [latin, nul],
  ]);
  expect(marks.rows.every((r) => r.readonly_reason)).toBe(true);

  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  const proposal = await proposeFileRename(
    t.pool,
    store,
    owner.id,
    project.id,
    ids['code/a.txt'],
    'code/a.py',
  );
  await renameFileAndReferences(
    t.pool,
    store,
    owner.id,
    project.id,
    ids['code/a.txt'],
    'code/a.py',
    proposal.digest,
  );
  expect(proposal.changes.map((c) => c.after)).toEqual(['\\lstinputlisting{code/a.py}']);
  expect(await buildsFine(project.id)).toBe('ok');
});
