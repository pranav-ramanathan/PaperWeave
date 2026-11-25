import { expect, test } from 'vitest';
import { type OpenConnection, overCap } from './server.ts';

const cap = { perFile: 2, perPerson: 3 };
const c = (userId: string, fileId: string, n: number): OpenConnection => ({ userId, fileId, n });

test('a person with room is not over the cap', () => {
  expect(overCap([], 'a', 'f1', Infinity, cap)).toBe(false);
  expect(overCap([c('a', 'f1', 1)], 'a', 'f1', Infinity, cap)).toBe(false);
});

test('a third connection to one file is over the per-file cap', () => {
  const open = [c('a', 'f1', 1), c('a', 'f1', 2)];
  expect(overCap(open, 'a', 'f1', Infinity, cap)).toBe(true);
  expect(overCap(open, 'a', 'f2', Infinity, cap)).toBe(false);
});

test('a fourth connection anywhere is over the per-person cap', () => {
  const open = [c('a', 'f1', 1), c('a', 'f1', 2), c('a', 'f2', 3)];
  expect(overCap(open, 'a', 'f3', Infinity, cap)).toBe(true);
  // With two of the three gone, there is room again, on any file.
  expect(overCap(open.slice(0, 2), 'a', 'f2', Infinity, cap)).toBe(false);
});

test('only connections of the same person count', () => {
  const open = [c('b', 'f1', 1), c('b', 'f1', 2), c('b', 'f2', 3)];
  expect(overCap(open, 'a', 'f1', Infinity, cap)).toBe(false);
});

test('ranked among the live: the newest is over, the ones before it are not', () => {
  // Six at once on one file, all live, cap two a file: the first two stay, the rest are over.
  const open = [1, 2, 3, 4, 5, 6].map((n) => c('a', 'f1', n));
  expect(open.map((x) => overCap(open, 'a', 'f1', x.n, cap))).toEqual([
    false,
    false,
    true,
    true,
    true,
    true,
  ]);
});

test('a connection that has gone makes room for the next, and a lower number is not bumped', () => {
  const open = [c('a', 'f1', 1), c('a', 'f1', 2), c('a', 'f1', 3)];
  expect(overCap(open, 'a', 'f1', 3, cap)).toBe(true);
  // Number 1 closed: number 3 is now second.
  const after = open.filter((x) => x.n !== 1);
  expect(overCap(after, 'a', 'f1', 3, cap)).toBe(false);
  // A connection is never ranked against ones that came after it.
  expect(overCap(after, 'a', 'f1', 2, cap)).toBe(false);
});

test('the per-person count is over all files, by rank', () => {
  const open = [c('a', 'f1', 1), c('a', 'f2', 2), c('a', 'f3', 3), c('a', 'f4', 4)];
  expect(open.map((x) => overCap(open, 'a', x.fileId, x.n, cap))).toEqual([
    false,
    false,
    false,
    true,
  ]);
});
