import { expect, test } from 'vitest';
import { editBudget } from './limits.ts';

const MINUTE = 60_000;
const small = () => editBudget({ burst: 1000, perMinute: 600, floor: 100 });

test('the burst is spent and then refused, and it is given back over time', () => {
  const b = small();
  expect(b.take('a', 600, 0)).toBe(true);
  expect(b.take('a', 400, 0)).toBe(true);
  // Spent: nothing more, and a refusal costs nothing.
  expect(b.take('a', 100, 0)).toBe(false);
  // 600 a minute is 10 a second: 5 s gives 50 back, which is not 100.
  expect(b.take('a', 100, 5_000)).toBe(false);
  expect(b.take('a', 100, 10_000)).toBe(true);
  expect(b.take('a', 100, 10_000)).toBe(false);
  // Given back up to the burst and no further.
  expect(b.take('a', 1000, 10_000 + 10 * MINUTE)).toBe(true);
  expect(b.take('a', 1, 10_000 + 10 * MINUTE)).toBe(false);
});

test('an edit costs the floor at least', () => {
  const b = small();
  // Ten edits of three bytes each cost 100, which is all of 1000.
  for (let i = 0; i < 10; i++) expect(b.take('a', 3, 0)).toBe(true);
  expect(b.take('a', 3, 0)).toBe(false);
});

test('two people have a budget each', () => {
  const b = small();
  expect(b.take('a', 1000, 0)).toBe(true);
  expect(b.take('a', 100, 0)).toBe(false);
  expect(b.take('b', 1000, 0)).toBe(true);
  expect(b.take('b', 100, 0)).toBe(false);
});

test('a bucket that is full again is forgotten', () => {
  const b = small();
  b.take('a', 500, 0);
  b.take('b', 500, 0);
  expect(b.size).toBe(2);
  // 500 is given back in 50 s at 10 a second; 'c' arriving later sweeps both out.
  b.take('c', 100, 49_000);
  expect(b.size).toBe(3);
  b.take('c', 100, 51_000);
  expect(b.size).toBe(1);
  // Forgotten is the same as full.
  expect(b.take('a', 1000, 51_000)).toBe(true);
});
