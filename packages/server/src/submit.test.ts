import { expect, test } from 'vitest';
import { leftOutMessage, readyMadeMessage } from './submit.ts';

const TAIL =
  'out of the PDF. Take the \\includeonly line out to build the whole paper, or take out the \\include lines of what is not meant to be in it.';

test('the message names what is left out, and the way out', () => {
  const n = (k: number) => Array.from({ length: k }, (_, i) => `c${i}`);
  expect(leftOutMessage(['ch/b'])).toBe(`\\includeonly leaves "ch/b" ${TAIL}`);
  expect(leftOutMessage(['ch/b', 'ch/c'])).toBe(`\\includeonly leaves "ch/b" and "ch/c" ${TAIL}`);
  expect(leftOutMessage(n(5))).toBe(`\\includeonly leaves "c0", "c1", "c2", "c3" and "c4" ${TAIL}`);
  expect(leftOutMessage(n(8))).toBe(
    `\\includeonly leaves "c0", "c1", "c2", "c3", "c4" and 3 more ${TAIL}`,
  );
});

test('a missing .bib on a build that succeeded is said as a warning, in one sentence', () => {
  expect(readyMadeMessage('refs.bib')).toBe(
    "refs.bib is not among the paper's files, so the bibliography was not made again: the PDF shows the paper's ready-made .bbl as it stands.",
  );
});
