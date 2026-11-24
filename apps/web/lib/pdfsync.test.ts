import { expect, test } from 'vitest';
import { intoWindow } from './pdfsync';

test('a band that is on the screen leaves the window where it is', () => {
  expect(intoWindow(300, 310, 800)).toBe(0);
  expect(intoWindow(0, 10, 800)).toBe(0);
  expect(intoWindow(790, 800, 800)).toBe(0);
});

test('a band below or above the screen is brought a third of the way down it', () => {
  // The pane is under the editor: the band is far below the bottom of the window.
  expect(intoWindow(1361, 1366, 568)).toBe(1361 - 189);
  // Cut by the bottom edge, or by the top one.
  expect(intoWindow(795, 805, 800)).toBe(528);
  expect(intoWindow(-4, 6, 600)).toBe(-204);
  // Above the window altogether: the window goes back up.
  expect(intoWindow(-900, -890, 600)).toBe(-1100);
});
