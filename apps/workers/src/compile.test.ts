import { expect, test } from 'vitest';
import { readFiles } from './compile.ts';

const FLS = [
  'PWD /work/paper',
  'INPUT /usr/share/texlive/texmf-dist/web2c/texmf.cnf',
  'INPUT ./main.tex',
  'OUTPUT main.log',
  'INPUT /usr/share/texlive/texmf-dist/tex/latex/base/article.cls',
  'INPUT ./sections/intro.tex',
  'INPUT ./figs//plot.png',
  'INPUT ./figs/my fig.pdf',
  'OUTPUT ./main.pdf',
  'INPUT ./main.aux',
  'INPUT ./sections/intro.tex',
  'INPUT ../shared/macros.sty',
  'INPUT ../../outside.tex',
].join('\n');

test('the .fls INPUT lines are project paths: once each, system files and OUTPUT lines dropped', () => {
  expect(readFiles(FLS, '')).toEqual([
    'main.tex',
    'sections/intro.tex',
    'figs/plot.png',
    'figs/my fig.pdf',
    'main.aux',
  ]);
});

test('a root in a folder: paths are relative to it, and ../ stays inside the project', () => {
  expect(readFiles(FLS, 'paper/')).toEqual([
    'paper/main.tex',
    'paper/sections/intro.tex',
    'paper/figs/plot.png',
    'paper/figs/my fig.pdf',
    'paper/main.aux',
    'shared/macros.sty',
  ]);
});

test('Windows line ends, an empty text and /work paths', () => {
  expect(
    readFiles('INPUT ./a.tex\r\nINPUT /work/b/c.tex\r\nINPUT /work/../x.tex\r\n', 'd/'),
  ).toEqual(['d/a.tex', 'b/c.tex']);
  expect(readFiles('')).toEqual([]);
});
