import { expect, test } from 'vitest';
import { onWaiting, waiting, waitingSince } from './waiting';

test('the page waits from the first holder to the last release', () => {
  let told = 0;
  const stop = onWaiting(() => told++);
  expect(waitingSince()).toBe(0);
  const a = waiting();
  const began = waitingSince();
  expect(began).toBeGreaterThan(0);
  const b = waiting();
  expect(waitingSince()).toBe(began);
  a();
  a(); // twice does no harm
  expect(waitingSince()).toBe(began);
  b();
  expect(waitingSince()).toBe(0);
  expect(told).toBe(4);
  stop();
  waiting()();
  expect(told).toBe(4);
});
