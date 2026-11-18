import { expect, test } from 'vitest';
import { diffLines } from './textdiff.ts';

const show = (a: string, b: string) => diffLines(a, b)!.map((l) => l.op + l.text);

test('a line diff keeps, removes and adds lines in order', () => {
  expect(show('a\nb\nc', 'a\nb\nc')).toEqual([' a', ' b', ' c']);
  expect(show('a\nb\nc', 'a\nX\nc')).toEqual([' a', '-b', '+X', ' c']);
  expect(show('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c']);
  expect(show('a\nb\nc', 'c')).toEqual(['-a', '-b', ' c']);
  expect(show('', 'x')).toEqual(['-', '+x']);
});

test('applying a diff to the old text gives the new text', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\nsix';
  const b = 'zero\none\nthree\n4\nfive\nsix\nseven';
  const lines = diffLines(a, b)!;
  expect(
    lines
      .filter((l) => l.op !== '+')
      .map((l) => l.text)
      .join('\n'),
  ).toBe(a);
  expect(
    lines
      .filter((l) => l.op !== '-')
      .map((l) => l.text)
      .join('\n'),
  ).toBe(b);
});

test('files too large to compare line by line are declined, not guessed at', () => {
  const big = (c: string) => Array.from({ length: 300 }, (_, i) => c + i).join('\n');
  expect(diffLines(big('a'), big('b'), 1000)).toBeNull();
});
