// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { createFile, deleteFile, setRootFile } from './files.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { acceptInvitation, createProject, getProject, invite } from './projects.ts';
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
