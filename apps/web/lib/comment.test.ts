import { expect, test } from 'vitest';
import { commentText } from './comment';

test('a comment reads as its words', () => {
  expect(commentText('% a')).toBe('a');
  expect(commentText('%')).toBe('');
  expect(commentText('%% a\n  % b')).toBe('a b');
  expect(commentText('\\footnote{x}')).toBeNull();
});
