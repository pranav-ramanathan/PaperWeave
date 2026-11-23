import { expect, test } from 'vitest';
import { carryLine, diffHunks, diffLines, diffWords } from './textdiff.ts';

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

const numbered = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n');
const hunks = (a: string, b: string, context?: number) => diffHunks(diffLines(a, b)!, context);

test('a hunk is the changed lines with three around them, and what was left out is counted', () => {
  const { hunks: h, rest } = hunks(numbered(400), numbered(400, { 200: 'changed' }));
  expect(h).toHaveLength(1);
  expect(h[0].skipped).toBe(196);
  expect(h[0].line).toBe(197);
  expect(h[0].rows.map((r) => r.op + r.text)).toEqual([
    ' line 197',
    ' line 198',
    ' line 199',
    '-line 200',
    '+changed',
    ' line 201',
    ' line 202',
    ' line 203',
  ]);
  expect(rest).toBe(197);
});

test('changes whose context touches are one hunk; far apart they are two', () => {
  const near = hunks(numbered(60), numbered(60, { 10: 'a', 16: 'b' }));
  expect(near.hunks).toHaveLength(1);
  const far = hunks(numbered(60), numbered(60, { 10: 'a', 40: 'b' }));
  expect(far.hunks).toHaveLength(2);
  // Lines 14 to 36 lie between the two hunks.
  expect(far.hunks[1].skipped).toBe(36 - 14 + 1);
  expect(far.hunks[1].line).toBe(37);
});

test('a change on the first and the last line leaves nothing before or after', () => {
  const r = hunks(numbered(30), numbered(30, { 1: 'first', 30: 'last' }));
  expect(r.hunks[0].skipped).toBe(0);
  expect(r.hunks[0].line).toBe(1);
  expect(r.rest).toBe(0);
});

test('one number changed in a long line marks just that number in both rows', () => {
  const long = (n: string) =>
    `${'The latency of the system stays low. '.repeat(20)}after ${n} runs ${'and so on. '.repeat(20)}`;
  const { hunks: h } = hunks(`a\n${long('forty')}\nb`, `a\n${long('thirty')}\nb`);
  const [gone, added] = h[0].rows.filter((r) => r.op !== ' ');
  expect(gone.words!.filter((p) => p.changed).map((p) => p.text)).toEqual(['forty']);
  expect(added.words!.filter((p) => p.changed).map((p) => p.text)).toEqual(['thirty']);
  expect(gone.words!.map((p) => p.text).join('')).toBe(gone.text);
  expect(added.words!.map((p) => p.text).join('')).toBe(added.text);
});

test('lines that are not counterparts stay whole-line changes', () => {
  const words = (a: string, b: string) =>
    hunks(a, b)
      .hunks[0].rows.filter((r) => r.op !== ' ')
      .map((r) => r.words);
  expect(words('alpha beta gamma', 'one two three')).toEqual([undefined, undefined]);
  // A line with nothing like it among the added ones stays whole.
  expect(words('keep this text', 'keep this text\nand this')).toEqual([undefined]);
  expect(words('', 'x')).toEqual([undefined, undefined]);
  // `b` is matched to its best counterpart `b x` (marked); `b y` has none left and stays whole.
  const pair = words('a\nb', 'a\nb x\nb y');
  expect(pair).toHaveLength(3);
  expect(pair.filter((w) => w !== undefined)).toHaveLength(2);
  expect(pair.filter((w) => w === undefined)).toHaveLength(1);
});

const P = (n: string) =>
  `${'The latency of the system stays low in every run. '.repeat(3)}After ${n} runs it was the same. ${'Nothing else moved at all. '.repeat(3)}`;
const changedRows = (a: string, b: string) =>
  hunks(a, b).hunks.flatMap((h) => h.rows.filter((r) => r.op !== ' '));
const marked = (ps: { changed: boolean; text: string }[] | undefined) =>
  ps?.filter((p) => p.changed).map((p) => p.text);

test('a changed line keeps its word marks when a paragraph is added after it', () => {
  const rows = changedRows(
    `a\n${P('forty')}\nb`,
    `a\n${P('thirty')}\n\nA new paragraph follows.\nb`,
  );
  const [gone, added, blank, fresh] = rows;
  expect(gone.op).toBe('-');
  expect(marked(gone.words)).toEqual(['forty']);
  expect(marked(added.words)).toEqual(['thirty']);
  expect(blank.words).toBeUndefined();
  expect(fresh.words).toBeUndefined();
});

test('a changed line keeps its word marks when a sentence is added on the next line', () => {
  const rows = changedRows(`a\n${P('forty')}\nb`, `a\n${P('thirty')}\nA second sentence here.\nb`);
  const gone = rows.find((r) => r.op === '-')!;
  const adds = rows.filter((r) => r.op === '+');
  expect(marked(gone.words)).toEqual(['forty']);
  expect(marked(adds[0].words)).toEqual(['thirty']);
  expect(adds[1].words).toBeUndefined();
});

test('a changed line keeps its word marks when a line above it is deleted', () => {
  const rows = changedRows(
    `a\nDelete this unrelated heading\n${P('forty')}\nb`,
    `a\n${P('thirty')}\nb`,
  );
  const gone = rows.filter((r) => r.op === '-');
  expect(gone[0].text).toBe('Delete this unrelated heading');
  expect(gone[0].words).toBeUndefined();
  expect(marked(gone[1].words)).toEqual(['forty']);
  expect(marked(rows.find((r) => r.op === '+')!.words)).toEqual(['thirty']);
});

test('a paragraph split by Enter is matched to its larger half', () => {
  const first = 'The latency of the system stays low in every run we made today.';
  const second = 'Nothing else moved at all.';
  const rows = changedRows(
    `a\n${first} ${second}\nb`,
    `a\n${first.replace('low', 'high')}\n\n${second}\nb`,
  );
  const adds = rows.filter((r) => r.op === '+');
  expect(rows.find((r) => r.op === '-')!.words).toBeDefined();
  expect(marked(adds[0].words)).toEqual(['high']);
  expect(adds[1].words).toBeUndefined();
  expect(adds[2].words).toBeUndefined();
});

test('equal counts are matched by likeness, not position', () => {
  const X = 'Completely unrelated heading text';
  const Y = 'Another thing entirely different';
  const rows = changedRows(`${X}\n${P('forty')}`, `${P('thirty')}\n${Y}`);
  const byText = (t: string) => rows.find((r) => r.text === t)!;
  expect(byText(X).words).toBeUndefined();
  expect(byText(Y).words).toBeUndefined();
  expect(marked(byText(P('forty')).words)).toEqual(['forty']);
  expect(marked(byText(P('thirty')).words)).toEqual(['thirty']);
});

test('pairs never cross', () => {
  const A = P('forty');
  const B = `${'Different material about caching and storage. '.repeat(3)}Hits were ten percent.`;
  const rows = changedRows(
    `${A}\n${B}`,
    `${B.replace('ten', 'twenty')}\n${A.replace('forty', 'thirty')}`,
  );
  expect(rows.filter((r) => r.op === '-' && r.words).length).toBeLessThanOrEqual(1);
  for (const r of rows) if (r.words) expect(r.words.map((p) => p.text).join('')).toBe(r.text);
});

test('a blank line is never a counterpart', () => {
  const rows = changedRows('', 'x');
  expect(rows.map((r) => r.words)).toEqual([undefined, undefined]);
  const r2 = changedRows('text line here', '');
  expect(r2.map((r) => r.words)).toEqual([undefined, undefined]);
});

test('guard: a big run pairs by index when counts are equal, and marks nothing when unrelated', () => {
  const line = (i: number, n: string) => `Row ${i} of the table says ${n} for the entry.`;
  const old = Array.from({ length: 11 }, (_, i) => line(i, 'one')).join('\n');
  const now = Array.from({ length: 11 }, (_, i) => line(i, 'two')).join('\n');
  const rows = changedRows(old, now);
  expect(rows.every((r) => marked(r.words)!.length === 1)).toBe(true);
  const other = Array.from({ length: 12 }, (_, i) => `Zq${i} wxyv${i} unrelated${i}`).join('\n');
  expect(changedRows(old, other).every((r) => r.words === undefined)).toBe(true);
});

test('with no changed line there are no hunks, and every line is the rest', () => {
  expect(diffHunks(diffLines(numbered(5), numbered(5))!)).toEqual({ hunks: [], rest: 5 });
});

test('random texts: nothing is lost between hunks, and rows are in order', () => {
  const N = Number(process.env.FUZZ ?? 500);
  for (let seed = 1; seed <= N; seed++) {
    let s = seed;
    const next = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s >>> 8) % n;
    };
    const text = () => Array.from({ length: next(40) }, () => `l${next(6)}`).join('\n');
    const all = diffLines(text(), text())!;
    const { hunks: h, rest } = diffHunks(all, next(4));
    const count = h.reduce((n, x) => n + x.skipped + x.rows.length, 0) + rest;
    if (count !== all.length) throw new Error(`seed ${seed}: ${count} of ${all.length}`);
    let at = 0;
    for (const x of h)
      for (const r of x.rows)
        if (r.words && r.words.map((p) => p.text).join('') !== r.text)
          throw new Error(`seed ${seed}: words do not join to text`);
    for (const x of h) {
      at += x.skipped;
      for (const r of x.rows) {
        const l = all[at++];
        if (l.op !== r.op || l.text !== r.text) throw new Error(`seed ${seed}: row out of order`);
      }
    }
  }
});
