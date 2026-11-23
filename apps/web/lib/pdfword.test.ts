import { expect, test } from 'vitest';
import { wordAt, wordIn } from './pdfword';

test('the word around a place in the PDF text is the run of letters and digits there', () => {
  const text = 'The quick, brown fox';
  expect(wordIn(text, 6)).toBe('quick');
  // Either edge of the word counts as in it.
  expect(wordIn(text, 4)).toBe('quick');
  expect(wordIn(text, 9)).toBe('quick');
  // Punctuation and spaces between words are nobody's.
  expect(wordIn(text, 10)).toBeNull();
  expect(wordIn('a , b', 2)).toBeNull();
  // A ligature is the letters it stands for.
  expect(wordIn('the ﬁnal word', 5)).toBe('final');
  expect(wordIn('ﬁ', 0)).toBe('fi');
  // One letter is too little to look for.
  expect(wordIn('a b', 0)).toBeNull();
  expect(wordIn('', 0)).toBeNull();
  expect(wordIn('x 42 y', 3)).toBe('42');
  expect(wordIn('naïve idea', 2)).toBe('naïve');
});

test('a word is found whole in a line of source, or the nearest word to how far along it was', () => {
  const line = 'one cat and a cat and concatenate cat';
  // A repeated word: the one nearest to the share of the line.
  expect(wordAt(line, 'cat', 0)).toEqual({ from: 4, to: 7 });
  expect(wordAt(line, 'cat', 0.4)).toEqual({ from: 14, to: 17 });
  expect(wordAt(line, 'cat', 1)).toEqual({ from: 34, to: 37 });
  // Without a share, the first. Never inside another word.
  expect(wordAt(line, 'cat')).toEqual({ from: 4, to: 7 });
  expect(wordAt('concatenate', 'cat')).toBeNull();
  expect(wordAt('a cat2 here', 'cat')).toBeNull();
  // Inside a command's braces.
  expect(wordAt('see \\emph{word} here', 'word')).toEqual({ from: 10, to: 14 });
  // Not there: with a share, the start of the word nearest to it, as a place; without, nothing.
  expect(wordAt('alpha beta gamma', 'zzz', 0.5)).toEqual({ from: 6, to: 6 });
  expect(wordAt('alpha beta gamma', 'zzz', 1)).toEqual({ from: 11, to: 11 });
  expect(wordAt('alpha beta gamma', 'zzz')).toBeNull();
  expect(wordAt('alpha beta gamma', undefined, 0.1)).toEqual({ from: 0, to: 0 });
  expect(wordAt('alpha beta gamma')).toBeNull();
  expect(wordAt('', 'x', 0.5)).toBeNull();
  // Offsets are into the line as typed, whatever comes before the word.
  expect(wordAt('Zürich – ﬁnal ﬁnal', 'final', 1)).toEqual({ from: 14, to: 18 });
  expect(wordAt('naïve — idea', 'idea')).toEqual({ from: 8, to: 12 });
  expect(wordAt('😀 word', 'word')).toEqual({ from: 3, to: 7 });
});
