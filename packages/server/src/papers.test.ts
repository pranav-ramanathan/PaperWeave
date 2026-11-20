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
