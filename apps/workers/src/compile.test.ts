import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  capDiagnostics,
  type Diagnostic,
  dedupeDiagnostics,
  diagnostics,
  MAX_DIAGNOSTICS,
  readFiles,
  readOwn,
} from './compile.ts';

const timedRun = <T>(run: () => T) => {
  const t = performance.now();
  const result = run();
  return { result, ms: Math.round(performance.now() - t) };
};

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

// Logs made here, line by line; no TeX is run.
describe('diagnostics: the same error again and again, and very many different ones', () => {
  const N = 20_000;
  const timed = timedRun;

  test('20,000 identical errors are one, and quickly', () => {
    const log = Array.from({ length: N }, () => './main.tex:3: Missing $ inserted.').join('\n');
    const { result, ms } = timed(() => diagnostics(log));
    expect(result).toEqual([
      { severity: 'error', file: 'main.tex', line: 3, message: 'Missing $ inserted.' },
    ]);
    expect(ms, `took ${ms} ms`).toBeLessThan(5000);
  });

  test('20,000 different errors take no longer than a moment', () => {
    const log = Array.from(
      { length: N },
      (_, i) => `./main.tex:${i + 1}: Missing $ inserted.`,
    ).join('\n');
    const { result, ms } = timed(() => diagnostics(log));
    // The first 1,000 in the log's order, and one that says how many were left out.
    expect(result).toHaveLength(MAX_DIAGNOSTICS + 1);
    expect(result[0]).toMatchObject({ line: 1 });
    expect(result[MAX_DIAGNOSTICS - 1]).toMatchObject({ line: MAX_DIAGNOSTICS });
    expect(result.at(-1)).toEqual({
      severity: 'error',
      message: `${N - MAX_DIAGNOSTICS} more messages left out. The build log has them all.`,
    });
    expect(ms, `took ${ms} ms`).toBeLessThan(5000);
  });
});

describe('dedupeDiagnostics and capDiagnostics', () => {
  const N = 20_000;
  const error = (line: number): Diagnostic => ({
    severity: 'error',
    file: 'main.tex',
    line,
    message: 'Missing $ inserted.',
  });

  test('20,000 identical entries are one, and 20,000 different ones are all kept, in order', () => {
    const same = timedRun(() => dedupeDiagnostics(Array.from({ length: N }, () => error(1))));
    expect(same.result).toEqual([error(1)]);
    expect(same.ms, `took ${same.ms} ms`).toBeLessThan(2000);
    const all = Array.from({ length: N }, (_, i) => error(i + 1));
    const distinct = timedRun(() => dedupeDiagnostics(all));
    expect(distinct.result).toEqual(all);
    expect(distinct.ms, `took ${distinct.ms} ms`).toBeLessThan(2000);
  });

  test('the first of the same entries keeps its place; a different field is a different entry', () => {
    const w: Diagnostic = { severity: 'warning', message: 'x' };
    expect(
      dedupeDiagnostics([error(2), w, error(1), error(2), { ...w, line: 3 }, w, error(1)]),
    ).toEqual([error(2), w, error(1), { ...w, line: 3 }]);
  });

  test('a list within the cap is as it was; past it, errors are kept before warnings', () => {
    const list = [error(1), { severity: 'warning' as const, message: 'w' }, error(2)];
    expect(capDiagnostics(list, 3)).toBe(list);
    expect(capDiagnostics(list, 2)).toEqual([
      error(1),
      error(2),
      { severity: 'warning', message: '1 more message left out. The build log has them all.' },
    ]);
  });

  test('when only warnings go, the note is a warning; when an error goes, an error', () => {
    const warnings = Array.from({ length: 5 }, (_, i): Diagnostic => ({
      severity: 'warning',
      message: `w${i}`,
    }));
    expect(capDiagnostics(warnings, 2).at(-1)).toEqual({
      severity: 'warning',
      message: '3 more messages left out. The build log has them all.',
    });
    expect(capDiagnostics([error(1), error(2), error(3)], 1).at(-1)?.severity).toBe('error');
  });
});
