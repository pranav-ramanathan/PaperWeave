import { expect, test } from 'vitest';
import { mapLimit, readAhead } from './batch.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A function that records how many calls are running at once. */
function gauge() {
  let now = 0;
  const g = {
    peak: 0,
    started: [] as number[],
    async run<T>(value: T, ms: number) {
      g.started.push(Number(value));
      g.peak = Math.max(g.peak, ++now);
      await sleep(ms);
      now--;
      return value;
    },
  };
  return g;
}

test('mapLimit keeps the order of the items and never runs more than the limit', async () => {
  const g = gauge();
  const items = Array.from({ length: 20 }, (_, i) => i);
  // Later items finish sooner, so an answer in the order of finishing would be reversed.
  const out = await mapLimit(items, 4, (i) => g.run(i, 25 - i));
  expect(out).toEqual(items);
  expect(g.peak).toBe(4);
});

test('mapLimit takes a short list, an empty one, and a limit above the length', async () => {
  expect(await mapLimit([], 8, async (x) => x)).toEqual([]);
  expect(await mapLimit([1, 2], 16, async (x, i) => x * 10 + i)).toEqual([10, 21]);
});

test('mapLimit stops starting items after a failure, and says what failed', async () => {
  const g = gauge();
  const items = Array.from({ length: 30 }, (_, i) => i);
  await expect(
    mapLimit(items, 2, async (i) => {
      if (i === 3) throw new Error('item 3');
      return g.run(i, 5);
    }),
  ).rejects.toThrow('item 3');
  expect(g.started.length).toBeLessThan(10);
});

test('readAhead hands items out in order while reading up to the limit ahead', async () => {
  const g = gauge();
  const items = Array.from({ length: 12 }, (_, i) => i);
  const got: number[] = [];
  for await (const v of readAhead(items, 4, (i) => g.run(i, 25 - i * 2))) got.push(v);
  expect(got).toEqual(items);
  expect(g.peak).toBe(4);
});

test('readAhead starts nothing it is not asked for, and starts no more once it is closed', async () => {
  const g = gauge();
  const items = Array.from({ length: 50 }, (_, i) => i);
  for await (const v of readAhead(items, 3, (i) => g.run(i, 2))) if (v === 4) break;
  await sleep(20);
  expect(g.started.length).toBeLessThanOrEqual(8);
});

test('readAhead raises a failure when its turn comes, and not before', async () => {
  const items = [0, 1, 2, 3];
  const seen: number[] = [];
  const read = async () => {
    for await (const v of readAhead(items, 4, async (i) => {
      if (i === 2) throw new Error('two');
      await sleep(5);
      return i;
    }))
      seen.push(v);
  };
  await expect(read()).rejects.toThrow('two');
  expect(seen).toEqual([0, 1]);
});
