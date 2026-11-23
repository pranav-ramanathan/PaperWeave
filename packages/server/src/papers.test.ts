import { expect, test } from 'vitest';
import { papers } from './import.ts';

const doc = Buffer.from('\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n');
const f = (path: string, bytes: Buffer = Buffer.from('x')) => ({ path, bytes });
const shape = (list: ReturnType<typeof papers>) =>
  list.map((p) => ({ dir: p.dir, name: p.name, paths: p.entries.map((e) => e.path) }));

test('a wrapping folder is taken off, and names the paper', () => {
  expect(
    shape(papers([f('proj/main.tex', doc), f('proj/figures/a.png'), f('proj/refs.bib')], [])),
  ).toEqual([{ dir: 'proj/', name: 'proj', paths: ['main.tex', 'figures/a.png', 'refs.bib'] }]);
});

test('a root in a folder with files beside it keeps its folder, and only a shared wrapper goes', () => {
  expect(shape(papers([f('src/main.tex', doc), f('figures/a.png'), f('refs.bib')], []))).toEqual([
    { dir: '', name: '', paths: ['src/main.tex', 'figures/a.png', 'refs.bib'] },
  ]);
  expect(shape(papers([f('proj/src/main.tex', doc), f('proj/figures/a.png')], []))).toEqual([
    { dir: 'proj/', name: 'proj', paths: ['src/main.tex', 'figures/a.png'] },
  ]);
});

test('two papers keep their folders, and what is shared between them is skipped with a reason', () => {
  const skipped: { path: string; reason: string }[] = [];
  const list = papers(
    [f('paper/main.tex', doc), f('poster/poster.tex', doc), f('figures/a.png')],
    skipped,
  );
  expect(shape(list)).toEqual([
    { dir: 'paper/', name: 'paper', paths: ['main.tex'] },
    { dir: 'poster/', name: 'poster', paths: ['poster.tex'] },
  ]);
  expect(skipped).toEqual([
    {
      path: 'figures/a.png',
      reason: 'shared between the papers in this archive: add it to each paper that needs it',
    },
  ]);
});

const reading = (body: string) =>
  Buffer.from(`\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`);
const SHARED = 'shared between the papers in this archive: add it to each paper that needs it';

test('a paper that reads shared files keeps the archive layout; one that reads none stays as it was', () => {
  const skipped: { path: string; reason: string }[] = [];
  const list = papers(
    [
      f('paper/main.tex', reading('\\includegraphics{../figures/a}\\bibliography{../refs}')),
      f('poster/poster.tex', doc),
      f('figures/a.png'),
      f('refs.bib'),
    ],
    skipped,
  );
  expect(shape(list)).toEqual([
    { dir: 'paper/', name: 'paper', paths: ['paper/main.tex', 'figures/a.png', 'refs.bib'] },
    { dir: 'poster/', name: 'poster', paths: ['poster.tex'] },
  ]);
  expect(list[0].note).toContain('keeps its folder (paper/)');
  expect(list[0].skipped.filter((s) => s.reason === SHARED)).toEqual([]);
  expect(list[1].note).toBeUndefined();
  expect(list[1].skipped.map((s) => s.path)).toEqual(['figures/a.png', 'refs.bib']);
});

test('under a wrapping folder only the wrapper goes, and dir is still the paper folder', () => {
  const list = papers(
    [
      f('repo/paper/main.tex', reading('\\includegraphics{../figures/a}')),
      f('repo/poster/poster.tex', doc),
      f('repo/figures/a.png'),
    ],
    [],
  );
  expect(shape(list)).toEqual([
    { dir: 'repo/paper/', name: 'paper', paths: ['paper/main.tex', 'figures/a.png'] },
    { dir: 'repo/poster/', name: 'poster', paths: ['poster.tex'] },
  ]);
  expect(list[0].note).toContain('keeps its folder (paper/)');
});

test('a file reached only through \\graphicspath counts as read', () => {
  const list = papers(
    [
      f('paper/main.tex', reading('\\graphicspath{{../figures/}}\\includegraphics{a}')),
      f('poster/poster.tex', doc),
      f('figures/a.png'),
    ],
    [],
  );
  expect(shape(list)[0].paths).toEqual(['paper/main.tex', 'figures/a.png']);
  expect(list[0].note).toBeDefined();
});
