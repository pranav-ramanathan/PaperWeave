import { expect, test } from 'vitest';
import {
  bblFormatMessage,
  leftOutMessage,
  readyMadeMessage,
  staleBblMessage,
  unusedMessage,
} from './submit.ts';

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

test('the message about unused files names the first ten, then how many more', () => {
  const n = (k: number) => Array.from({ length: k }, (_, i) => `f${i}.tex`);
  expect(unusedMessage(['cover-letter.tex'])).toBe(
    'The last build never opened cover-letter.tex. It is in the ZIP, and left out of the ZIP of only the files the paper uses.',
  );
  const ten = unusedMessage(n(10));
  expect(ten).toContain(
    'f0.tex, f1.tex, f2.tex, f3.tex, f4.tex, f5.tex, f6.tex, f7.tex, f8.tex, f9.tex.',
  );
  expect(ten).not.toContain('more');
  const eleven = unusedMessage(n(11));
  expect(eleven).toContain('f9.tex and 1 more.');
  expect(eleven).not.toContain('f10.tex');
});

test('the message about the paper own .bbl says the PDF came from another bibliography', () => {
  const m = staleBblMessage('paper/main.bbl');
  expect(m).toContain('The PDF was built from another bibliography than paper/main.bbl');
  expect(m).toContain('keeps paper/main.bbl as it is');
});

test('the message about a Biber .bbl names the format and that a venue may refuse it', () => {
  expect(bblFormatMessage('main.bbl', '3.2')).toBe(
    'main.bbl was made for biblatex .bbl format 3.2. A venue with a different biblatex version will refuse the file.',
  );
});
