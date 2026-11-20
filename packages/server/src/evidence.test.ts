import { expect, test } from 'vitest';
import { squash } from './evidence.ts';

test('squash keeps the letters and digits of every script', () => {
  expect(squash('Müller')).toBe('muller');
  expect(squash('{Literate} Pro-gramming, 2nd ed.')).toBe('literateprogramming2nded');
  expect(squash('ﬁrst')).toBe('first');
  expect(squash('Ørsted')).toBe(squash('{\\O}rsted'));
  // Different words in a script other than Latin stay different.
  expect(squash('机器学习')).toBe('机器学习');
  expect(squash('机器学习')).not.toBe(squash('深度学习'));
  expect(squash('Квантовая механика')).toBe('квантоваямеханика');
  expect(squash('Квантовая механика')).not.toBe(squash('Теория относительности'));
  // Nothing to keep: empty, which callers do not count as a match.
  expect(squash('?! – …')).toBe('');
});
