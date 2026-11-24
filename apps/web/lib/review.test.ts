import { expect, test } from 'vitest';
import { reviewWaiting } from './review.ts';

test('a paper with nothing waiting says nothing', () => {
  expect(reviewWaiting({ threads: 0, proposals: 0 })).toBe('');
});

test('what waits is counted in words, proposed changes first', () => {
  expect(reviewWaiting({ threads: 1, proposals: 0 })).toBe('1 open thread');
  expect(reviewWaiting({ threads: 3, proposals: 0 })).toBe('3 open threads');
  expect(reviewWaiting({ threads: 0, proposals: 1 })).toBe('1 proposed change waiting');
  expect(reviewWaiting({ threads: 0, proposals: 2 })).toBe('2 proposed changes waiting');
  expect(reviewWaiting({ threads: 1, proposals: 2 })).toBe(
    '2 proposed changes waiting, 1 open thread',
  );
});
