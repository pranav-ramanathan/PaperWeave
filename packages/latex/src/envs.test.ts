import { expect, test } from 'vitest';
import { MAX_PROSE_ENVS, proseEnvs, validEnv } from './envs.ts';

const doc = (pre: string, body = '') =>
  `\\documentclass{article}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`;
const envs = (pre: string, more: Record<string, string> = {}, body = '') =>
  proseEnvs({ 'main.tex': doc(pre, body), ...more }, 'main.tex');

test('each declaration form names its environments', () => {
  expect(
    envs(
      [
        '\\newtheorem{observation}{Observation}',
        '\\newtheorem*{fact}{Fact}',
        '\\newtheorem{notion}[observation]{Notion}[section]',
        '\\spnewtheorem{finding}[observation]{Finding}{\\bfseries}{\\itshape}',
        '\\declaretheorem[style=plain]{ax, postulate}',
        '\\declaretheorem{rule}',
        '\\newmdtheoremenv[linewidth=1pt]{boxed}{Boxed}',
      ].join('\n'),
    ),
  ).toEqual(['ax', 'boxed', 'fact', 'finding', 'notion', 'observation', 'postulate', 'rule']);
});

test('a declaration that is commented out is ignored', () => {
  expect(
    envs('% \\newtheorem{ghost}{Ghost}\n\\newtheorem{real}{Real} % \\newtheorem{late}{L}'),
  ).toEqual(['real']);
});

test('names that are not prose, or not names, are dropped', () => {
  const pre = ['verbatim', 'align', 'a{b', 'itemize', 'figure*', 'document', 'x1']
    .map((n) => `\\newtheorem{${n}}{T}`)
    .join('\n');
  expect(envs(pre + '\n\\declaretheorem{equation*, ok}')).toEqual(['ok']);
  expect(validEnv('observation')).toBe(true);
  expect(validEnv('a'.repeat(33))).toBe(false);
  expect(validEnv('align*')).toBe(false);
  expect(validEnv(7)).toBe(false);
});

test('at most 64 names, sorted', () => {
  const names = Array.from(
    { length: 80 },
    (_, i) =>
      'e' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)),
  );
  const got = envs(names.map((n) => `\\newtheorem{${n}}{T}`).join('\n'));
  expect(got).toHaveLength(MAX_PROSE_ENVS);
  expect(got).toEqual([...got].sort());
});

test('a .sty the preamble loads is read; one it does not is not', () => {
  const files = {
    'local.sty': '\\newtheorem{observation}{Observation}',
    'other.sty': '\\newtheorem{unused}{Unused}',
    'deep.sty': '\\newtheorem{deeper}{Deeper}',
  };
  expect(envs('\\usepackage{local}', files)).toEqual(['observation']);
  expect(
    envs('\\usepackage{amsmath, local}', { ...files, 'local.sty': '\\RequirePackage{deep}' }),
  ).toEqual(['deeper']);
});

test('a declaration after \\begin{document}, or in a file not reached, is ignored', () => {
  expect(
    envs('', { 'extra.tex': '\\newtheorem{x}{X}' }, '\\newtheorem{late}{Late}\\input{extra}'),
  ).toEqual([]);
});

test('files the preamble inputs are read', () => {
  expect(envs('\\input{defs}', { 'defs.tex': '\\newtheorem{observation}{O}' })).toEqual([
    'observation',
  ]);
});

test('no root text, no names', () => {
  expect(proseEnvs({}, 'main.tex')).toEqual([]);
});
