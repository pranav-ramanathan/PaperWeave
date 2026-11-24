import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFiles, readOwn } from './compile.ts';

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

// The links below are made here, directly, in a temp directory; no build is involved.
describe('readOwn: build outputs are read without following links', () => {
  let top: string;
  let root: string;
  let outside: string;
  beforeAll(() => {
    top = mkdtempSync(join(tmpdir(), 'paperweave-readown-'));
    root = join(top, 'work');
    outside = join(top, 'outside');
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'main.pdf'), 'plain output');
    writeFileSync(join(root, 'sub', 'a.aux'), 'nested output');
    writeFileSync(join(root, 'empty.bbl'), '');
    writeFileSync(join(outside, 'secret.txt'), "not the build's");
    writeFileSync(join(outside, 'real.aux'), 'in a real folder, outside');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.pdf'));
    symlinkSync(join(root, 'main.pdf'), join(root, 'inside-link.pdf'));
    symlinkSync(outside, join(root, 'linked-dir'));
    symlinkSync(join(root, 'sub'), join(root, 'inside-dir'));
    writeFileSync(join(root, 'big.log'), Buffer.alloc(1001, 97));
    writeFileSync(join(root, 'exact.log'), Buffer.alloc(1000, 97));
  });
  afterAll(() => rmSync(top, { recursive: true, force: true }));

  test('a regular file is read, whole, also in a folder and when empty', () => {
    expect(readOwn(root, join(root, 'main.pdf'), 1000)?.toString()).toBe('plain output');
    expect(readOwn(root, join(root, 'sub', 'a.aux'), 1000)?.toString()).toBe('nested output');
    expect(readOwn(root, join(root, 'empty.bbl'), 1000)?.length).toBe(0);
  });

  test('a link to a file outside root is absent', () => {
    expect(readOwn(root, join(root, 'linked.pdf'), 1000)).toBeUndefined();
  });

  test('a link to a file inside root is absent too: no link is followed', () => {
    expect(readOwn(root, join(root, 'inside-link.pdf'), 1000)).toBeUndefined();
  });

  test('a file in a linked folder is absent, whether the folder points out or in', () => {
    expect(readOwn(root, join(root, 'linked-dir', 'real.aux'), 1000)).toBeUndefined();
    expect(readOwn(root, join(root, 'inside-dir', 'a.aux'), 1000)).toBeUndefined();
  });

  test('a file over the cap is absent; one at the cap is read', () => {
    expect(readOwn(root, join(root, 'big.log'), 1000)).toBeUndefined();
    expect(readOwn(root, join(root, 'exact.log'), 1000)?.length).toBe(1000);
  });

  test('a path outside root is absent, however it is spelt', () => {
    expect(readOwn(root, join(outside, 'real.aux'), 1000)).toBeUndefined();
    expect(readOwn(root, join(root, '..', 'outside', 'real.aux'), 1000)).toBeUndefined();
    expect(readOwn(root, root, 1000)).toBeUndefined();
    expect(readOwn(root, join(root, 'sub'), 1000)).toBeUndefined();
  });

  test('a missing file, or one under a file, is absent', () => {
    expect(readOwn(root, join(root, 'nothing.pdf'), 1000)).toBeUndefined();
    expect(readOwn(root, join(root, 'main.pdf', 'x'), 1000)).toBeUndefined();
  });
});
