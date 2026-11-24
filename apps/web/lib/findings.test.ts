import type { LanguageFinding } from '@paperweave/server';
import { expect, test } from 'vitest';
import { after, lines, placeOf, toShow } from './findings';

const spelt = (
  from: string,
  words: string,
  more: Partial<LanguageFinding> = {},
): LanguageFinding => ({
  from,
  to: `${from}'`,
  words,
  reads: words,
  message: 'Possible spelling mistake found.',
  replacements: ['measurement'],
  addable: true,
  rule: 'MORFOLOGIK_RULE_EN_GB',
  kind: 'spelling',
  ...more,
});
const grammar = (from: string, words: string): LanguageFinding => ({
  ...spelt(from, words),
  message: 'Possible typo: you repeated a word.',
  rule: 'ENGLISH_WORD_REPEAT_RULE',
  kind: 'grammar',
});

test('a misspelt word is one line however often it stands in the file, where it first stands', () => {
  const found = [
    spelt('a', 'measurment'),
    spelt('b', 'recieved', { replacements: ['received'] }),
    spelt('c', 'measurment'),
    grammar('d', 'the the'),
    spelt('e', 'measurment'),
    spelt('f', 'recieved', { replacements: ['received'] }),
  ];
  const got = lines(found);
  expect(got.map((l) => l.places.map((f) => f.from))).toEqual([['a', 'c', 'e'], ['b', 'f'], ['d']]);
  // The very findings, not copies: the panel takes one off its list by what it is.
  expect(got[0].places[1]).toBe(found[2]);
  expect(new Set(got.map((l) => l.key)).size).toBe(3);
});

test('a line is the same line at the next check, with fewer or more places', () => {
  const first = lines([spelt('a', 'measurment'), spelt('c', 'measurment')]);
  const next = lines([grammar('x', 'the the'), spelt('c', 'measurment')]);
  expect(next[1].key).toBe(first[0].key);
});

test('grammar and style are never put together, and one finding alone reads as before', () => {
  const got = lines([grammar('a', 'the the'), grammar('b', 'the the'), spelt('c', 'teh')]);
  expect(got.map((l) => l.places.length)).toEqual([1, 1, 1]);
  expect(got[0].key).toBe('a:ENGLISH_WORD_REPEAT_RULE:0');
  expect(got[1].key).toBe('b:ENGLISH_WORD_REPEAT_RULE:1');
});

test('places the checker says different things about are not one line', () => {
  const got = lines([
    spelt('a', 'teh', { replacements: ['the', 'tea'] }),
    spelt('b', 'teh', { replacements: ['tech', 'the'] }),
    spelt('c', 'Teh', { replacements: ['The'] }),
    spelt('d', 'teh', { replacements: ['the', 'tea'], message: 'Another message.' }),
    spelt('e', 'na\\"ive', { reads: 'naïve' }),
    spelt('f', 'naïve', { reads: 'naïve' }),
    spelt('g', 'teh', { replacements: ['the', 'tea'] }),
  ]);
  expect(got.map((l) => l.places.map((f) => f.from))).toEqual([
    ['a', 'g'],
    ['b'],
    ['c'],
    ['d'],
    ['e'],
    ['f'],
  ]);
  // Only the three suggestions that are drawn count.
  const four = lines([
    spelt('a', 'teh', { replacements: ['1', '2', '3', '4'] }),
    spelt('b', 'teh', { replacements: ['1', '2', '3', '5'] }),
  ]);
  expect(four).toHaveLength(1);
});

test('a line stands at its first place until the text is shown another', () => {
  const [line] = lines([spelt('a', 'teh'), spelt('b', 'teh'), spelt('c', 'teh')]);
  expect(placeOf(line, undefined)).toBe(0);
  expect(placeOf(line, { from: 'b', shown: true })).toBe(1);
  // The place it stood at is gone (changed here or by someone else): the first again.
  expect(placeOf(line, { from: 'zz', shown: true })).toBe(0);
});

test('"Show in the text" shows the place the line stands at, then steps through the others and round', () => {
  const [line] = lines([spelt('a', 'teh'), spelt('b', 'teh'), spelt('c', 'teh')]);
  expect(toShow(line, undefined)).toBe(0);
  expect(toShow(line, { from: 'a', shown: true })).toBe(1);
  expect(toShow(line, { from: 'b', shown: true })).toBe(2);
  expect(toShow(line, { from: 'c', shown: true })).toBe(0);
  // Stood at but not shown yet (the one before it was just changed): this one first.
  expect(toShow(line, { from: 'b', shown: false })).toBe(1);
  // The place shown is gone: the first, and it has not been shown.
  expect(toShow(line, { from: 'zz', shown: true })).toBe(0);
  const [one] = lines([spelt('a', 'teh')]);
  expect(toShow(one, { from: 'a', shown: true })).toBe(0);
});

test('after a place is dealt with the line stands at the next one, not yet shown', () => {
  const [line] = lines([spelt('a', 'teh'), spelt('b', 'teh'), spelt('c', 'teh')]);
  expect(after(line, 0)).toEqual({ from: 'b', shown: false });
  expect(after(line, 2)).toEqual({ from: 'a', shown: false });
  expect(after(lines([spelt('a', 'teh')])[0], 0)).toBeUndefined();
  // What the panel does: the place is taken off, and the line stands where `after` said.
  const left = lines([spelt('a', 'teh'), spelt('c', 'teh')])[0];
  expect(placeOf(left, after(line, 1))).toBe(1);
  expect(toShow(left, after(line, 1))).toBe(1);
});
