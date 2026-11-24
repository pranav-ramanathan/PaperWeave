// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { compile } from '../../../apps/workers/src/compile.ts';
import { LIMITS, readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { AppError } from './errors.ts';
import {
  createFile,
  deleteFile,
  fileUses,
  picture,
  pictureDigest,
  pictures,
  proposeFileRename,
  renameFileAndReferences,
  replaceFile,
  setRootFile,
} from './files.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { acceptInvitation, createProject, getProject, invite, setRole } from './projects.ts';
import { listRevisions, renameFile, restoreRevision, saveRevision } from './revisions.ts';
import * as Y from 'yjs';
import { saveChart, listCharts } from './charts.ts';
import { approveDataset, datasetProposal, listDatasets } from './data.ts';
import { currentBytes, editFile, loadUpdates, openFile, TEXT } from './sync.ts';
import { listThreads, startThread } from './threads.ts';
import { exportRevision } from './revisions.ts';
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

test('the list of a paper’s files is for the people on the paper only', async () => {
  const p = await paper();
  // What the files route behind an open editor answers with: refused for a stranger, whatever
  // the paper's files are called, and the same list for a member of any role.
  expect(await code(listFiles(t.pool, outsider.id, p.id))).toBe('not_found');
  expect(await code(listFiles(t.pool, outsider.id, 'not-an-id'))).toBe('not_found');
  expect((await listFiles(t.pool, viewer.id, p.id)).map((f) => f.path)).toEqual(await paths(p.id));
});

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

test('a ready-made .bbl can be added, replaced and renamed, and stays a stored file', async () => {
  const p = await paper();
  const one = Buffer.from('\\begin{thebibliography}{1}\n\\bibitem{a} A.\n\\end{thebibliography}\n');
  const two = Buffer.from(one.toString().replace('{a}', '{b}'));
  const bbl = await createFile(t.pool, store, owner.id, p.id, 'main.bbl', one);
  expect(await paths(p.id)).toContain('main.bbl');
  expect(await replaceFile(t.pool, store, owner.id, p.id, 'main.bbl', two)).toBe(bbl);
  const out = (await readZip(await exportZip(t.pool, store, owner.id, p.id))).entries.find(
    (e) => e.path === 'main.bbl',
  )!;
  expect(Buffer.from(out.bytes)).toEqual(two);
  const proposal = await proposeFileRename(t.pool, store, owner.id, p.id, bbl, 'paper.bbl');
  expect(
    await renameFileAndReferences(t.pool, store, owner.id, p.id, bbl, 'paper.bbl', proposal.digest),
  ).toMatchObject({ places: 0 });
  expect(await paths(p.id)).toContain('paper.bbl');
  // Build output other than a .bbl is still refused, and a viewer may not add one.
  expect(await code(createFile(t.pool, store, owner.id, p.id, 'main.blg'))).toBe('invalid_input');
  expect(await code(createFile(t.pool, store, viewer.id, p.id, 'x.bbl'))).toBe('permission_denied');
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

/** What a call comes to: its result, or the error's code (a raw database error shows as its SQLSTATE). */
const outcome = (run: Promise<unknown>) =>
  run.then(
    () => 'ok',
    (e) => (e instanceof AppError ? e.code : `raw:${e.code ?? e.message}`),
  );

test('making a file the root while it is being deleted is refused cleanly, and the root stays live', async () => {
  const p = await paper();
  let rooting!: Promise<string>;
  const deleting = outcome(
    deleteFile(
      holdingFiles(async () => {
        rooting = outcome(setRootFile(t.pool, owner.id, p.id, p.intro));
        await untilSomeoneWaits();
      }),
      store,
      owner.id,
      p.id,
      p.intro,
    ),
  );
  expect(await deleting).toBe('ok');
  expect(await rooting).toBe('not_found');
  const { rows } = await t.pool.query(
    `select p.root_file_id, f.deleted_at from projects p join all_files f on f.id = p.root_file_id
     where p.id = $1`,
    [p.id],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].root_file_id).toBe(p.main);
  expect(rows[0].deleted_at).toBeNull();
});

test('two renames to the same new name: one wins, the other is told the name is taken', async () => {
  const p = await paper();
  // Each checks that the name is free, then waits for the other to have checked too.
  let checked = 0;
  let both!: () => void;
  const bothChecked = new Promise<void>((r) => (both = r));
  const racing = new Proxy(t.pool, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop !== 'query') return typeof v === 'function' ? v.bind(target) : v;
      return async (sql: string, params?: unknown[]) => {
        const result = await target.query(sql, params);
        if (/path = \$2 and id <> \$3/.test(sql)) {
          if (++checked === 2) both();
          await bothChecked;
        }
        return result;
      };
    },
  });
  const results = await Promise.all([
    outcome(renameFile(racing, owner.id, p.id, p.main, 'same.tex')),
    outcome(renameFile(racing, owner.id, p.id, p.intro, 'same.tex')),
  ]);
  expect(results.sort()).toEqual(['conflict', 'ok']);
  expect((await paths(p.id)).filter((x) => x === 'same.tex')).toHaveLength(1);
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

test('renaming a chapter changes its name in \\includeonly too', async () => {
  const main = [
    '\\documentclass{book}',
    '\\includeonly{chapters/intro , % chapters/intro',
    '  chapters/method.tex,chapters/gone}',
    '\\begin{document}',
    '\\include{chapters/intro}',
    '\\include{chapters/method.tex}',
    '\\include{chapters/results}',
    '\\end{document}',
    '',
  ].join('\n');
  const zip = await writeZip(
    Object.entries({
      'main.tex': main,
      'chapters/intro.tex': 'Intro.\n',
      'chapters/method.tex': 'Method.\n',
      'chapters/results.tex': 'Results.\n',
    }).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Imported');
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  const rename = async (from: string, to: string) => {
    const proposal = await proposeFileRename(t.pool, store, owner.id, project.id, ids[from], to);
    const done = await renameFileAndReferences(
      t.pool,
      store,
      owner.id,
      project.id,
      ids[from],
      to,
      proposal.digest,
    );
    return { list: proposal.changes.map((c) => `${c.path}:${c.line} ${c.after}`), done };
  };
  const a = await rename('chapters/intro.tex', 'parts/introduction.tex');
  expect(a.list).toEqual([
    'main.tex:2 \\includeonly{parts/introduction , % chapters/intro',
    'main.tex:5 \\include{parts/introduction}',
  ]);
  expect(a.done.places).toBe(2);
  expect((await rename('chapters/method.tex', 'chapters/design.tex')).list).toEqual([
    'main.tex:3   chapters/design.tex,chapters/gone}',
    'main.tex:6 \\include{chapters/design.tex}',
  ]);
  expect((await rename('chapters/results.tex', 'parts/results.tex')).list).toEqual([
    'main.tex:7 \\include{parts/results}',
  ]);
  expect((await content(project.id))['main.tex']).toBe(
    main
      .replace('\\includeonly{chapters/intro ,', '\\includeonly{parts/introduction ,')
      .replace('\\include{chapters/intro}', '\\include{parts/introduction}')
      .replace('  chapters/method.tex,', '  chapters/design.tex,')
      .replace('\\include{chapters/method.tex}', '\\include{chapters/design.tex}')
      .replace('\\include{chapters/results}', '\\include{parts/results}'),
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

test('a file cannot share a name with a folder, nor have a part of its path over 255 bytes', async () => {
  const p = await paper();
  // A file used as a folder, and a folder used as a file: neither can be written to disk.
  expect(await code(createFile(t.pool, store, owner.id, p.id, 'main.tex/notes.tex'))).toBe(
    'invalid_input',
  );
  const made = await createFile(t.pool, store, owner.id, p.id, 'assets.tex/a.png');
  expect(made).toBeTruthy();
  const x = await createFile(t.pool, store, owner.id, p.id, 'x.tex');
  expect(await code(renameFile(t.pool, owner.id, p.id, x, 'assets.tex'))).toBe('invalid_input');
  expect(await code(createFile(t.pool, store, owner.id, p.id, 'assets.tex'))).toBe('invalid_input');
  await expect(createFile(t.pool, store, owner.id, p.id, 'main.tex/notes.tex')).rejects.toThrow(
    'cannot share the name "main.tex"',
  );
  // A path that is only a file's name with something after it in the same folder is fine.
  await createFile(t.pool, store, owner.id, p.id, 'main.tex.bak.tex');
  // The limit is 255 bytes a part, not characters.
  expect(await code(createFile(t.pool, store, owner.id, p.id, `${'漢'.repeat(200)}.tex`))).toBe(
    'invalid_input',
  );
  expect(await code(renameFile(t.pool, owner.id, p.id, x, `sub/${'漢'.repeat(200)}.tex`))).toBe(
    'invalid_input',
  );
  expect(await code(createFile(t.pool, store, owner.id, p.id, `${'漢'.repeat(80)}.tex`))).toBe(
    'ok',
  );
  expect(await paths(p.id)).toContain(`${'漢'.repeat(80)}.tex`);
});

test('an archive that has a file and a folder of one name imports the file and reports the rest', async () => {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: 'a.tex', bytes: Buffer.from('A\n') },
    { path: 'a.tex/b.tex', bytes: Buffer.from('B\n') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Collide');
  const listed = await paths(project.id);
  // Never both: the paper must be writable to disk.
  expect(listed).toContain('a.tex/b.tex');
  expect(listed).not.toContain('a.tex');
});

// Replacing a file keeps its ID, so what is tied to the ID (a dataset's description, the charts
// drawn from it) stays tied.
const bytesOf = async (fileId: string) =>
  currentBytes(
    t.pool,
    store,
    (await t.pool.query('select id, digest, eol, bom, head_seq from files where id = $1', [fileId]))
      .rows[0],
  );
const text = (s: string) => Uint8Array.from(Buffer.from(s));
const REPLACE_WORDS = 'Tick "Replace the file of this name" to put this file in its place.';

test('a file can be replaced by a newer copy, keeping its ID, its dataset and its chart', async () => {
  const p = await paper();
  const csv = await createFile(
    t.pool,
    store,
    owner.id,
    p.id,
    'results.csv',
    text('x,y\n1,2\n3,4\n'),
  );
  const seen = await datasetProposal(t.pool, store, owner.id, p.id, csv);
  await approveDataset(t.pool, store, owner.id, p.id, csv, {
    version: seen.version,
    columns: [
      { name: 'x', type: 'number', unit: '' },
      { name: 'y', type: 'number', unit: '' },
    ],
    missing: [],
    exported: true,
  });
  await saveChart(t.pool, store, owner.id, p.id, {
    name: 'trend',
    dataset: csv,
    kind: 'line',
    x: 'x',
    y: 'y',
  });
  expect((await listDatasets(t.pool, store, owner.id, p.id))[0].changed).toBe(false);
  // Without the flag, a conflict that says what to do.
  const clash = await createFile(
    t.pool,
    store,
    owner.id,
    p.id,
    'results.csv',
    text('x,y\n9,9\n'),
  ).catch((e) => e);
  expect(clash.code).toBe('conflict');
  expect(clash.message).toBe(`Another file already has that name. ${REPLACE_WORDS}`);

  const v2 = text('x,y\n1,2\n3,4\n5,6\n');
  expect(await replaceFile(t.pool, store, owner.id, p.id, 'results.csv', v2)).toBe(csv);
  expect(Buffer.from(await bytesOf(csv)).toString()).toBe('x,y\n1,2\n3,4\n5,6\n');
  expect((await paths(p.id)).filter((x) => x === 'results.csv')).toHaveLength(1);
  const sets = await listDatasets(t.pool, store, owner.id, p.id);
  expect(sets).toHaveLength(1);
  expect(sets[0].changed).toBe(true);
  // Still tied to the file (the worker test draws it and sees it out of date).
  expect((await listCharts(t.pool, store, owner.id, p.id))[0].dataPath).toBe('results.csv');
  // The content before is in the revision the replace cut (listed before an export cuts another).
  const revs = await listRevisions(t.pool, owner.id, p.id);
  expect((await content(p.id))['results.csv']).toBe('x,y\n1,2\n3,4\n5,6\n');
  const before = (
    await readZip((await exportRevision(t.pool, store, owner.id, p.id, revs[0].id)).zip)
  ).entries.find((e) => e.path === 'results.csv')!;
  expect(Buffer.from(before.bytes).toString()).toBe('x,y\n1,2\n3,4\n');
});

test('replacing a long text file with a copy changed at both ends keeps a thread between', async () => {
  const p = await paper();
  const copy =
    Array.from({ length: 2600 }, (_, i) =>
      i === 1300 ? 'Which wolves howl loudly at night?' : `Row ${i} keeps its words.`,
    ).join('\n') + '\n';
  const file = await createFile(t.pool, store, owner.id, p.id, 'long.tex', text(copy));
  // Typed in at both ends, so the file has edits and the replace goes through its log.
  await editFile(t.pool, store, file, owner.id, (tx) => {
    for (const [from, to] of [
      ['Row 5 keeps', 'Row 5 lost'],
      ['Row 2595 keeps', 'Row 2595 lost'],
    ]) {
      const at = tx.toString().indexOf(from);
      tx.delete(at, from.length);
      tx.insert(at, to);
    }
  });
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  const live = doc.getText(TEXT);
  const at = live.toString().indexOf('wolves howl');
  await startThread(t.pool, store, owner.id, p.id, file, {
    from: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(live, at, 0)),
    to: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(live, at + 11, -1)),
    body: 'Which wolves?',
  });
  expect(await replaceFile(t.pool, store, owner.id, p.id, 'long.tex', text(copy))).toBe(file);
  expect((await content(p.id))['long.tex']).toBe(copy);
  expect((await listThreads(t.pool, store, owner.id, p.id)).map((x) => x.state)).toEqual([
    'attached',
  ]);
});

test('a picture is replaced under the same ID and the old one stays in a revision', async () => {
  const p = await paper();
  const one = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 1, 1]);
  const two = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2, 2, 2, 2]);
  const fig = await createFile(t.pool, store, owner.id, p.id, 'fig.png', one);
  const was = (await pictureDigest(t.pool, store, owner.id, p.id, 'fig.png')).digest;
  expect(await replaceFile(t.pool, store, owner.id, p.id, 'fig.png', two)).toBe(fig);
  const now = (await pictureDigest(t.pool, store, owner.id, p.id, 'fig.png')).digest;
  expect(now).not.toBe(was);
  expect(Buffer.from((await picture(t.pool, store, owner.id, p.id, 'fig.png')).bytes)).toEqual(two);
  // The revision the replace cut holds the paper as it was.
  const old = (await listRevisions(t.pool, owner.id, p.id))[0];
  const out = (
    await readZip((await exportRevision(t.pool, store, owner.id, p.id, old.id)).zip)
  ).entries.find((e) => e.path === 'fig.png')!;
  expect(Buffer.from(out.bytes)).toEqual(one);
});

test('only someone who may write can replace a file, and a folder or an unreadable text is refused', async () => {
  const p = await paper();
  expect(await code(replaceFile(t.pool, store, viewer.id, p.id, 'intro.tex', text('x\n')))).toBe(
    'permission_denied',
  );
  expect(await code(replaceFile(t.pool, store, outsider.id, p.id, 'intro.tex', text('x\n')))).toBe(
    'not_found',
  );
  await createFile(t.pool, store, owner.id, p.id, 'sub/a.tex', text('A\n'));
  expect(await code(replaceFile(t.pool, store, owner.id, p.id, 'sub', text('x\n')))).toBe(
    'invalid_input',
  );
  // Text that people edit is not turned into a read-only file by bytes that are not text.
  expect(
    await code(
      replaceFile(
        t.pool,
        store,
        owner.id,
        p.id,
        'intro.tex',
        Uint8Array.from([0xff, 0xfe, 0, 0x80, 0x81]),
      ),
    ),
  ).toBe('invalid_input');
  expect(Buffer.from(await bytesOf(p.intro)).toString()).toBe('Intro text.\n');
  // A path with no file is added.
  const added = await replaceFile(t.pool, store, owner.id, p.id, 'new.tex', text('N\n'));
  expect(await paths(p.id)).toContain('new.tex');
  expect(added).toBeTruthy();
});

test('text with other line endings replaces text, and connected editors see it', async () => {
  const p = await paper();
  const csv = await createFile(t.pool, store, owner.id, p.id, 'rows.csv', text('a,b\n1,2\n'));
  // Opened by an editor, which holds its own copy of the document.
  const theirs = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, csv)) Y.applyUpdate(theirs, u);
  expect(theirs.getText(TEXT).toString()).toBe('a,b\n1,2\n');
  await replaceFile(t.pool, store, owner.id, p.id, 'rows.csv', text('a,b\r\n1,2\r\n3,4\r\n'));
  const row = (
    await t.pool.query('select eol, bom, readonly_reason from files where id = $1', [csv])
  ).rows[0];
  expect(row).toMatchObject({ eol: 'crlf', bom: false, readonly_reason: null });
  expect(Buffer.from(await bytesOf(csv)).toString()).toBe('a,b\r\n1,2\r\n3,4\r\n');
  for (const u of await loadUpdates(t.pool, store, csv)) Y.applyUpdate(theirs, u);
  expect(theirs.getText(TEXT).toString()).toBe('a,b\n1,2\n3,4\n');
  // Typed on top, then replaced again: the exported file is the latest.
  await editFile(t.pool, store, csv, owner.id, (tx) => tx.insert(0, '#'));
  await replaceFile(t.pool, store, owner.id, p.id, 'rows.csv', text('z\n'));
  expect((await content(p.id))['rows.csv']).toBe('z\n');
});

test('a name LaTeX cannot spell is refused for a new or renamed file, but existing ones still work', async () => {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN + '\\includegraphics{fig.png}\n') },
    { path: 'fig.png', bytes: PNG },
    { path: '50%.png', bytes: PNG },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Hostile');
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  // An imported paper keeps the name it came with, and a replace of it still works.
  expect(Object.keys(ids)).toContain('50%.png');
  expect(await code(replaceFile(t.pool, store, owner.id, project.id, '50%.png', PNG))).toBe('ok');
  const before = (await content(project.id))['main.tex'];
  for (const ch of ['%', '#', '"', '{', '}']) {
    const to = `a${ch}b.png`;
    expect(await code(createFile(t.pool, store, owner.id, project.id, to)), to).toBe(
      'invalid_input',
    );
    expect(await code(createFile(t.pool, store, owner.id, project.id, `d${ch}x/a.png`)), to).toBe(
      'invalid_input',
    );
    expect(await code(replaceFile(t.pool, store, owner.id, project.id, to, PNG)), to).toBe(
      'invalid_input',
    );
    expect(
      await code(proposeFileRename(t.pool, store, owner.id, project.id, ids['fig.png'], to)),
      to,
    ).toBe('invalid_input');
    expect(
      await code(renameFileAndReferences(t.pool, store, owner.id, project.id, ids['fig.png'], to)),
      to,
    ).toBe('invalid_input');
    expect(await code(renameFile(t.pool, owner.id, project.id, ids['fig.png'], to)), to).toBe(
      'invalid_input',
    );
  }
  expect((await content(project.id))['main.tex']).toBe(before);
  expect(await paths(project.id)).toContain('fig.png');
  // Renaming away from such a name is fine.
  expect(await code(renameFile(t.pool, owner.id, project.id, ids['50%.png'], 'fifty.png'))).toBe(
    'ok',
  );
});

const NFC_PNG = 'figs/Übersicht.png';
const NFD_PNG = 'figs/Übersicht.png';

test('a file added under a decomposed name is stored composed, and a reference to it resolves', async () => {
  const p = await paper();
  await createFile(t.pool, store, owner.id, p.id, NFD_PNG, PNG);
  expect(await paths(p.id)).toContain(NFC_PNG);
  expect(await paths(p.id)).not.toContain(NFD_PNG);
  expect(await pictureDigest(t.pool, store, owner.id, p.id, 'figs/Übersicht')).toMatchObject({
    type: 'image/png',
  });
});

test('replacing under either spelling keeps one file, and a rename is stored composed', async () => {
  const p = await paper();
  const fig = await createFile(t.pool, store, owner.id, p.id, NFC_PNG, PNG);
  expect(await replaceFile(t.pool, store, owner.id, p.id, NFD_PNG, PNG)).toBe(fig);
  expect((await paths(p.id)).filter((x) => x.startsWith('figs/'))).toEqual([NFC_PNG]);
  await renameFile(t.pool, owner.id, p.id, p.intro, 'méthode.tex');
  expect(await paths(p.id)).toContain('méthode.tex');
  expect(await paths(p.id)).not.toContain('intro.tex');
});

test('a paper stored with a decomposed name has that file replaced, not a look-alike added', async () => {
  const p = await paper();
  const one = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 1, 1]);
  const two = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2, 2, 2, 2]);
  const row = (
    await t.pool.query(
      'insert into files (project_id, path, digest, size, readonly_reason) values ($1, $2, $3, $4, $5) returning id',
      [p.id, NFD_PNG, await store.put(one), one.length, 'picture'],
    )
  ).rows[0].id;
  const before = (await paths(p.id)).length;
  expect(await replaceFile(t.pool, store, owner.id, p.id, NFC_PNG, two)).toBe(row);
  expect(await paths(p.id)).toHaveLength(before);
  expect(Buffer.from(await bytesOf(row))).toEqual(two);
});

test('the lines that name a file are found before it is deleted', async () => {
  const main =
    '\\documentclass{article}\n\\graphicspath{{figures/}}\n\\begin{document}\n' +
    '\\input{sections/intro}\n% \\input{sections/intro}\n\\includegraphics{plot}\n' +
    '\\bibliography{refs}\n\\end{document}\n';
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(main) },
    { path: 'sections/intro.tex', bytes: Buffer.from('Intro.\n') },
    { path: 'figures/plot.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) },
    { path: 'refs.bib', bytes: Buffer.from('@book{a, title={A}}\n') },
    { path: 'notes.tex', bytes: Buffer.from('Notes.\n') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Uses');
  const { token } = await invite(t.pool, owner.id, project.id, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  const uses = (path: string) => fileUses(t.pool, store, owner.id, project.id, ids[path]);
  expect(await uses('sections/intro.tex')).toEqual({
    path: 'sections/intro.tex',
    root: false,
    lines: [{ path: 'main.tex', line: 4, text: '\\input{sections/intro}' }],
  });
  expect((await uses('figures/plot.png')).lines).toEqual([
    { path: 'main.tex', line: 6, text: '\\includegraphics{plot}' },
  ]);
  expect((await uses('refs.bib')).lines).toEqual([
    { path: 'main.tex', line: 7, text: '\\bibliography{refs}' },
  ]);
  expect((await uses('notes.tex')).lines).toEqual([]);
  expect(await uses('main.tex')).toMatchObject({ root: true });
  expect(await code(fileUses(t.pool, store, viewer.id, project.id, ids['notes.tex']))).toBe(
    'permission_denied',
  );
  expect(await code(fileUses(t.pool, store, owner.id, project.id, crypto.randomUUID()))).toBe(
    'not_found',
  );
  // Looking changes nothing.
  expect(await paths(project.id)).toContain('sections/intro.tex');
});
