import { expect, test } from 'vitest';
import { carryLine, diffLines } from './textdiff.ts';

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

const carry = (a: string, b: string, line: number, way: 'toNow' | 'toBuilt') =>
  carryLine(diffLines(a, b)!, line, way);
const lines = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `line ${from + i}`).join('\n');

test('a line is carried across edits: kept lines exactly, others to the nearest kept line', () => {
  // Ten lines added above: every line is ten further down, and none has moved to somewhere else.
  const built = lines(20);
  const now = `${Array.from({ length: 10 }, (_, i) => `new ${i}`).join('\n')}\n${built}`;
  expect(carry(built, now, 13, 'toNow')).toEqual({ line: 23, moved: false });
  expect(carry(built, now, 23, 'toBuilt')).toEqual({ line: 13, moved: false });
  // An added line has no place in the built text: the next kept line after it.
  expect(carry(built, now, 4, 'toBuilt')).toEqual({ line: 1, moved: true });

  // A deleted paragraph: its lines go to the first line after it, and those after it move up.
  const para = 'p1\np2\np3';
  const before = `a\nb\n${para}\nc\nd`;
  const after = 'a\nb\nc\nd';
  expect(carry(before, after, 4, 'toNow')).toEqual({ line: 3, moved: true });
  expect(carry(before, after, 3, 'toNow')).toEqual({ line: 3, moved: true });
  expect(carry(before, after, 6, 'toNow')).toEqual({ line: 3, moved: false });
  expect(carry(before, after, 2, 'toNow')).toEqual({ line: 2, moved: false });
  expect(carry(before, after, 4, 'toBuilt')).toEqual({ line: 7, moved: false });
  // Removed at the end: the nearest kept line before it.
  expect(carry('a\nb\nc', 'a', 3, 'toNow')).toEqual({ line: 1, moved: true });
  // Added at the end, asked back.
  expect(carry('a', 'a\nb\nc', 3, 'toBuilt')).toEqual({ line: 1, moved: true });
});

test('with no diff, because the texts were too large to compare, the line stays and is moved', () => {
  expect(diffLines(lines(3000), lines(3000, 2), 100)).toBeNull();
  expect(carryLine(null, 17, 'toNow')).toEqual({ line: 17, moved: true });
  expect(carryLine(null, 17, 'toBuilt')).toEqual({ line: 17, moved: true });
});
