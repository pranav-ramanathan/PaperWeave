import { includes } from '@paperweave/latex';
import { expect, test } from 'vitest';
import { nameSplices } from './files.ts';

/** `src` after the splices that make its one include name `path`. */
const renamed = (src: string, path: string) => {
  const [inc] = includes(src);
  let out = src;
  for (const h of nameSplices(inc, path).sort((a, b) => b.at - a.at))
    out = out.slice(0, h.at) + h.insert + out.slice(h.at + h.length);
  return out;
};

test('a file renamed in an \\input line is replaced whole', () => {
  expect(renamed('x \\input{sections/a} y', 'parts/b')).toBe('x \\input{parts/b} y');
});

test('a path in two groups is replaced group by group, keeping the style of the folder', () => {
  const to = (src: string, path: string) => renamed(src, path);
  expect(to('\\import{sections/}{a}', 'sections/b')).toBe('\\import{sections/}{b}');
  expect(to('\\import{sections/}{a}', 'parts/b')).toBe('\\import{parts/}{b}');
  expect(to('\\subimport{ sections }{ a }', 'parts/deeper/b')).toBe(
    '\\subimport{ parts/deeper }{ b }',
  );
  expect(to('\\includefrom{sections/}{a}', 'b')).toBe('\\includefrom{}{b}');
  expect(to('\\import{}{a}', 'parts/a')).toBe('\\import{parts/}{a}');
  expect(nameSplices(includes('\\import{s/}{a}')[0], 's/a')).toEqual([]);
});

test('a file renamed in an \\includeonly entry is replaced whole', () => {
  expect(renamed('\\includeonly{ sections/a }', 'parts/b')).toBe('\\includeonly{ parts/b }');
});
