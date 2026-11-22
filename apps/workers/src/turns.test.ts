import { expect, test } from 'vitest';
import { takeTurns } from './turns.ts';

test('a chart is drawn between builds while builds remain queued, and builds go on after it', async () => {
  const left = { build: 4, draw: 1 };
  const done: string[] = [];
  const take = (k: 'build' | 'draw') => async () =>
    left[k] > 0 ? (left[k]--, done.push(k), true) : false;
  const next = takeTurns(take('build'), take('draw'));
  while (await next());
  expect(done).toEqual(['build', 'draw', 'build', 'build', 'build']);
});

test('builds are not held back by charts either', async () => {
  const left = { build: 1, draw: 3 };
  const done: string[] = [];
  const take = (k: 'build' | 'draw') => async () =>
    left[k] > 0 ? (left[k]--, done.push(k), true) : false;
  const next = takeTurns(take('build'), take('draw'));
  while (await next());
  expect(done).toEqual(['build', 'draw', 'draw', 'draw']);
});
