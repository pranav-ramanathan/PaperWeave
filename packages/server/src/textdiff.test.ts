import { expect, test } from 'vitest';
import { carryLine, diffLines, diffWords } from './textdiff.ts';

const show = (a: string, b: string) => diffLines(a, b)!.map((l) => l.op + l.text);

test('a line diff keeps, removes and adds lines in order', () => {
  expect(show('a\nb\nc', 'a\nb\nc')).toEqual([' a', ' b', ' c']);
  expect(show('a\nb\nc', 'a\nX\nc')).toEqual([' a', '-b', '+X', ' c']);
  expect(show('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c']);
  expect(show('a\nb\nc', 'c')).toEqual(['-a', '-b', ' c']);
  expect(show('', 'x')).toEqual(['-', '+x']);
});

test('applying a diff to the old text gives the new text', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\nsix';
  const b = 'zero\none\nthree\n4\nfive\nsix\nseven';
  const lines = diffLines(a, b)!;
  expect(
    lines
      .filter((l) => l.op !== '+')
      .map((l) => l.text)
      .join('\n'),
  ).toBe(a);
  expect(
    lines
      .filter((l) => l.op !== '-')
      .map((l) => l.text)
      .join('\n'),
  ).toBe(b);
});

test('files too large to compare line by line are declined, not guessed at', () => {
  const big = (c: string) => Array.from({ length: 300 }, (_, i) => c + i).join('\n');
  expect(diffLines(big('a'), big('b'), 1000)).toBeNull();
});

const carry = (a: string, b: string, line: number, way: 'toNow' | 'toBuilt') =>
  carryLine(diffLines(a, b)!, line, way);
const lines = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `line ${from + i}`).join('\n');

test('a line is carried across edits: kept lines exactly, others to the nearest kept line', () => {
  // Ten lines added above: every line is ten further down, and none has moved to somewhere else.
  const built = lines(20);
  const now = `${Array.from({ length: 10 }, (_, i) => `new ${i}`).join('\n')}\n${built}`;
  expect(carry(built, now, 13, 'toNow')).toEqual({ line: 23, moved: false });
  expect(carry(built, now, 23, 'toBuilt')).toEqual({ line: 13, moved: false });
  // An added line has no place in the built text: the next kept line after it.
  expect(carry(built, now, 4, 'toBuilt')).toEqual({ line: 1, moved: true });

  // A deleted paragraph: its lines go to the first line after it, and those after it move up.
  const para = 'p1\np2\np3';
  const before = `a\nb\n${para}\nc\nd`;
  const after = 'a\nb\nc\nd';
  expect(carry(before, after, 4, 'toNow')).toEqual({ line: 3, moved: true });
  expect(carry(before, after, 3, 'toNow')).toEqual({ line: 3, moved: true });
  expect(carry(before, after, 6, 'toNow')).toEqual({ line: 3, moved: false });
  expect(carry(before, after, 2, 'toNow')).toEqual({ line: 2, moved: false });
  expect(carry(before, after, 4, 'toBuilt')).toEqual({ line: 7, moved: false });
  // Removed at the end: the nearest kept line before it.
  expect(carry('a\nb\nc', 'a', 3, 'toNow')).toEqual({ line: 1, moved: true });
  // Added at the end, asked back.
  expect(carry('a', 'a\nb\nc', 3, 'toBuilt')).toEqual({ line: 1, moved: true });
});

test('with no diff, because the texts were too large to compare, the line stays and is moved', () => {
  expect(diffLines(lines(3000), lines(3000, 2), 100)).toBeNull();
  expect(carryLine(null, 17, 'toNow')).toEqual({ line: 17, moved: true });
  expect(carryLine(null, 17, 'toBuilt')).toEqual({ line: 17, moved: true });
});

const changed = (pieces: { changed: boolean; text: string }[]) =>
  pieces.filter((p) => p.changed).map((p) => p.text);

test('a word diff marks only the words that change', () => {
  const d = diffWords('Nothing else is claimed here.', 'Nothing more is claimed here.')!;
  expect(changed(d.was)).toEqual(['else']);
  expect(changed(d.now)).toEqual(['more']);
});

test('a changed phrase is one piece, not two words around a kept space', () => {
  const d = diffWords('forty milliseconds', 'thirty ms')!;
  expect(d.was).toEqual([{ changed: true, text: 'forty milliseconds' }]);
  expect(d.now).toEqual([{ changed: true, text: 'thirty ms' }]);
});

test('numbers, commands and hyphenated words are compared whole', () => {
  const n = diffWords('p < 0.05', 'p < 0.5')!;
  expect([changed(n.was), changed(n.now)]).toEqual([['0.05'], ['0.5']]);
  const c = diffWords('\\cite{a}', '\\citep{a}')!;
  expect([changed(c.was), changed(c.now)]).toEqual([['\\cite'], ['\\citep']]);
  const h = diffWords('thirty-five', 'thirty-six')!;
  expect([changed(h.was), changed(h.now)]).toEqual([['thirty-five'], ['thirty-six']]);
});

test('a change of spacing alone is only white space', () => {
  const d = diffWords('a b', 'a\nb')!;
  const all = [...d.was, ...d.now].filter((p) => p.changed);
  expect(all.length).toBe(2);
  expect(all.every((p) => !p.text.trim())).toBe(true);
});

test('an addition marks nothing in the old text', () => {
  const d = diffWords('claimed', 'claimed or implied')!;
  expect(changed(d.was)).toEqual([]);
  expect(changed(d.now)).toEqual([' or implied']);
});

test('texts too large to compare word by word are declined', () => {
  expect(diffWords('a b', 'c d', 1)).toBeNull();
});

test('random word lists: the pieces join back to both texts', () => {
  const N = Number(process.env.FUZZ ?? 2000);
  const vocab = ['a', 'b', 'the', '0.05', '\\cite', 'x-y', ' ', '  ', '\n', '{', '.', 'é'];
  for (let seed = 1; seed <= N; seed++) {
    let s = seed;
    const next = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s >>> 8) % n;
    };
    const text = () =>
      Array.from({ length: next(12) }, () => vocab[next(vocab.length)]).join(next(2) ? ' ' : '');
    const a = text();
    const b = text();
    const d = diffWords(a, b)!;
    const was = d.was.map((p) => p.text).join('');
    const now = d.now.map((p) => p.text).join('');
    if (was !== a || now !== b) throw new Error(`seed ${seed}: ${JSON.stringify([a, b, d])}`);
  }
});
