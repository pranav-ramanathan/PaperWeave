import { expect, test } from 'vitest';
import { lineNumbers } from './labels.ts';

test('a place is on the line that counting from the top of the text says it is', () => {
  const SEED = 20261119;
  let seed = SEED;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let round = 0; round < 200; round++) {
    // Short lines, empty lines, both kinds of line end, and sometimes no end to the last one.
    const text =
      Array.from(
        { length: next() % 40 },
        () => 'x'.repeat(next() % 5) + (next() % 3 ? '\n' : '\r\n'),
      ).join('') + 'x'.repeat(next() % 3);
    const line = lineNumbers(text);
    for (let at = 0; at <= text.length; at++)
      expect(line(at), `seed ${SEED}, round ${round}, place ${at}`).toBe(
        text.slice(0, at).split('\n').length,
      );
  }
  expect(lineNumbers('')(0)).toBe(1);
});
