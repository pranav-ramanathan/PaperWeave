import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { whileShown } from './shown';

const page = { hidden: false };
beforeEach(() => {
  vi.useFakeTimers();
  page.hidden = false;
  vi.stubGlobal('document', {
    get hidden() {
      return page.hidden;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Work that takes `took` ms and notes when it started. */
function work(took = 0) {
  const t0 = Date.now();
  const starts: number[] = [];
  return {
    starts,
    run: () => {
      starts.push(Date.now() - t0);
      return new Promise<void>((r) => setTimeout(r, took));
    },
  };
}

test('now() while idle does the work at once, and the next turn is ms after it ends', async () => {
  const w = work(100);
  const stop = whileShown(w.run, 1000);
  await vi.advanceTimersByTimeAsync(100 + 600); // first turn done, 600 ms into its wait
  expect(w.starts).toEqual([0]);
  stop.now();
  await vi.advanceTimersByTimeAsync(0);
  expect(w.starts).toEqual([0, 700]);
  await vi.advanceTimersByTimeAsync(100 + 999); // 1099 after the start of the second: not yet
  expect(w.starts).toEqual([0, 700]);
  await vi.advanceTimersByTimeAsync(1);
  expect(w.starts).toEqual([0, 700, 1800]);
  stop();
});

test('now() while the work is under way does it exactly once more, straight after', async () => {
  const w = work(500);
  const stop = whileShown(w.run, 5000);
  await vi.advanceTimersByTimeAsync(200);
  stop.now();
  stop.now();
  await vi.advanceTimersByTimeAsync(300); // first ends at 500
  await vi.advanceTimersByTimeAsync(0);
  expect(w.starts).toEqual([0, 500]);
  await vi.advanceTimersByTimeAsync(500 + 4999);
  expect(w.starts).toEqual([0, 500]);
  stop();
});

test('now() while hidden or after stop does nothing', async () => {
  const w = work();
  const stop = whileShown(w.run, 1000);
  await vi.advanceTimersByTimeAsync(10);
  page.hidden = true;
  stop.now();
  await vi.advanceTimersByTimeAsync(5000);
  expect(w.starts).toEqual([0]);
  page.hidden = false;
  stop();
  stop.now();
  await vi.advanceTimersByTimeAsync(5000);
  expect(w.starts).toEqual([0]);
});
