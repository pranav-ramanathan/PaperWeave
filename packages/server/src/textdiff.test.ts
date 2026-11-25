import { expect, test } from 'vitest';
import { restoreEdits } from './revisions.ts';
import type { DiffLine } from './textdiff.ts';
import {
  carryLine,
  diffHunks,
  diffLines,
  diffLinesFar,
  diffWords,
  FAR_EDITS,
  merge3,
  resolveMerge,
  wholeFile,
} from './textdiff.ts';

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

// A seeded generator, so that a failure can be run again.
const dice = (seed: number) => () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const plain = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
const side = (lines: DiffLine[], drop: '+' | '-') =>
  lines
    .filter((l) => l.op !== drop)
    .map((l) => l.text)
    .join('\n');

test('two changes far apart in a long file are compared, where the table alone declines', () => {
  const a = plain(5000);
  const b = a.slice();
  b[9] = 'changed near the top';
  b.splice(4990, 1);
  b.splice(2500, 0, 'added in the middle');
  expect(diffLines(a.join('\n'), b.join('\n'))).toBeNull();
  const lines = diffLinesFar(a.join('\n'), b.join('\n'))!;
  expect(lines.filter((l) => l.op !== ' ').map((l) => l.op + l.text)).toEqual([
    '-line 9',
    '+changed near the top',
    '+added in the middle',
    '-line 4990',
  ]);
  expect(side(lines, '+')).toBe(a.join('\n'));
  expect(side(lines, '-')).toBe(b.join('\n'));
  const { hunks, rest } = diffHunks(lines);
  expect(hunks.map((h) => [h.skipped, h.line, h.rows.length])).toEqual([
    [6, 7, 8],
    [2484, 2498, 7],
    [2484, 4989, 7],
  ]);
  expect(rest).toBe(6);
});

test("where the table answers, the far comparison gives the table's answer unchanged", () => {
  const [a, b] = ['a\nb\nc\nd', 'a\nX\nc\nY\nd'];
  expect(diffLinesFar(a, b)).toEqual(diffLines(a, b));
  expect(diffLinesFar('', 'x')).toEqual(diffLines('', 'x'));
});

test("the far comparison is as short as the table's, rebuilds both texts and puts removals first", () => {
  const rand = dice(202);
  for (let round = 0; round < 300; round++) {
    // Few distinct lines, so that the same line turns up in many places.
    const text = (n: number) =>
      Array.from({ length: n }, () => 'abcde'[Math.floor(rand() * 5)]).join('\n');
    const a = text(Math.floor(rand() * 40));
    let b = text(Math.floor(rand() * 40));
    if (round % 3 === 0) {
      // Or an edited copy: a few lines changed, removed and added.
      const l = a.split('\n');
      for (let e = 0; e < 4; e++) {
        const at = Math.floor(rand() * (l.length + 1));
        if (rand() < 0.5) l.splice(at, 1);
        else l.splice(at, 0, 'x');
      }
      b = l.join('\n');
    }
    const table = diffLines(a, b)!;
    const far = diffLinesFar(a, b, 0)!;
    const where = JSON.stringify([a, b]);
    expect(side(far, '+'), where).toBe(a);
    expect(side(far, '-'), where).toBe(b);
    expect(far.filter((l) => l.op !== ' ').length, where).toBe(
      table.filter((l) => l.op !== ' ').length,
    );
    // No added line directly before a removed one.
    expect(
      far.some((l, i) => l.op === '+' && far[i + 1]?.op === '-'),
      where,
    ).toBe(false);
  }
});

test('more changed lines than the far comparison shows are declined, not guessed at', () => {
  const block = (word: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n');
  // 2,100 lines replaced by 2,100 others: 4,200 changed lines, over both limits.
  expect(diffLinesFar(block('old', 2100), block('new', 2100))).toBeNull();
  // Exactly at the limit, and one over (forced past the table).
  const a = plain(3000);
  const drop = (k: number) => a.filter((_, i) => i % 3 !== 0 || i >= 3 * k).join('\n');
  const at = diffLinesFar(
    a.join('\n'),
    drop(FAR_EDITS / 2) + '\n' + block('new', FAR_EDITS / 2),
    0,
  )!;
  expect(at.filter((l) => l.op !== ' ')).toHaveLength(FAR_EDITS);
  expect(
    diffLinesFar(a.join('\n'), drop(FAR_EDITS / 2) + '\n' + block('new', FAR_EDITS / 2 + 1), 0),
  ).toBeNull();
});

test('a long file of one repeated line is declined in bounded time when its changes are many', () => {
  const blank = (n: number) => '\n'.repeat(n);
  const a = blank(400_000) + plain(1500).join('\n') + blank(400_000);
  const b = blank(400_500) + plain(1500).reverse().join('\n') + blank(399_000);
  const t0 = performance.now();
  expect(diffLinesFar(a, b)).toBeNull();
  expect(performance.now() - t0).toBeLessThan(5000);
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

test('a line is carried exactly across changes too far apart for the table', () => {
  const a = plain(5000);
  const b = a.slice();
  b.splice(9, 0, 'added near the top');
  b[4990] = 'changed near the bottom';
  expect(diffLines(a.join('\n'), b.join('\n'))).toBeNull();
  const far = diffLinesFar(a.join('\n'), b.join('\n'));
  expect(carryLine(far, 2500, 'toNow')).toEqual({ line: 2501, moved: false });
  expect(carryLine(far, 2501, 'toBuilt')).toEqual({ line: 2500, moved: false });
});

/** The text with `edits` applied in the order given, as the restore applies them. */
function applyEdits(have: string, edits: { at: number; del: number; ins: string }[]) {
  let text = have;
  for (const e of edits) text = text.slice(0, e.at) + e.ins + text.slice(e.at + e.del);
  return text;
}

test('a restore across two distant changes replaces only those two places', () => {
  const have = plain(5000);
  const want = have.slice();
  want[6] = 'line 6 edited';
  want[4989] = 'line 4989 edited';
  expect(diffLines(have.join('\n'), want.join('\n'))).toBeNull();
  const edits = restoreEdits(have.join('\n'), want.join('\n'));
  expect(edits).toHaveLength(2);
  expect(applyEdits(have.join('\n'), edits)).toBe(want.join('\n'));
  expect(edits.reduce((n, e) => n + e.del, 0)).toBeLessThan(20);
});

test('a restore of scattered changes in a long file deletes little of it', () => {
  for (const seed of [11, 12, 13]) {
    const rand = dice(seed);
    const have = Array.from(
      { length: 3000 },
      (_, i) => `Sentence ${i} of the paper has some words.`,
    );
    const want = have.slice();
    // 60 distinct lines of the original, each reworded, one removed or one added beside it.
    const at = new Set<number>();
    while (at.size < 60) at.add(Math.floor(rand() * 3000));
    for (const i of [...at].sort((x, y) => y - x)) {
      const kind = rand();
      if (kind < 0.7) want[i] = `Sentence ${i} of the paper has other words ${seed}.`;
      else if (kind < 0.85) want.splice(i, 1);
      else want.splice(i, 0, `A new line before ${i}.`);
    }
    const [a, b] = [have.join('\n'), want.join('\n')];
    const edits = restoreEdits(a, b);
    const why = `seed ${seed}`;
    expect(applyEdits(a, edits), why).toBe(b);
    const deleted = edits.reduce((n, e) => n + e.del, 0);
    expect(deleted, why).toBeLessThan(a.length * 0.05);
  }
});

test('a restore of a short file edits the changed words, and of an unchanged one does nothing', () => {
  const have = 'one\ntwo words here\nthree\nfour\n';
  const want = 'one\ntwo other here\nthree\n';
  const edits = restoreEdits(have, want);
  expect(edits).toContainEqual({ at: 8, del: 5, ins: 'other' });
  expect(applyEdits(have, edits)).toBe(want);
  expect(restoreEdits(have, have)).toEqual([]);
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

test('a whole file is every line added or removed, and a last newline starts no line', () => {
  expect(wholeFile('a\nb\n', '+', 10)).toEqual({
    lines: [
      { op: '+', text: 'a' },
      { op: '+', text: 'b' },
    ],
    more: 0,
  });
  // The same lines with no newline at the end, and removed.
  expect(wholeFile('a\nb', '-', 10).lines).toEqual([
    { op: '-', text: 'a' },
    { op: '-', text: 'b' },
  ]);
  // Blank lines are lines; only the one newline that ends the text is not.
  expect(wholeFile('a\n\n\n', '+', 10).lines.map((l) => l.text)).toEqual(['a', '', '']);
  expect(wholeFile('\n', '+', 10).lines.map((l) => l.text)).toEqual(['']);
});

test('the text of an empty file has no lines', () => {
  expect(wholeFile('', '+', 10)).toEqual({ lines: [], more: 0 });
  expect(wholeFile('', '-', 0)).toEqual({ lines: [], more: 0 });
});

test('a whole file past the cap gives the cap and counts the rest', () => {
  const text = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const whole = wholeFile(text, '+', FAR_EDITS);
  expect(whole.lines).toHaveLength(FAR_EDITS);
  expect(whole.more).toBe(500);
  expect(whole.lines[0]).toEqual({ op: '+', text: 'line 0' });
  expect(whole.lines.at(-1)).toEqual({ op: '+', text: 'line 1999' });
  // Exactly the cap leaves nothing; a cap of nothing leaves everything.
  expect(wholeFile('a\nb\n', '+', 2).more).toBe(0);
  expect(wholeFile('a\nb\n', '+', 0)).toEqual({ lines: [], more: 2 });
});

test('the lines of a whole file go through diffHunks as one hunk of changed rows', () => {
  const { lines } = wholeFile('a\nb\nc\n', '-', 10);
  const { hunks, rest } = diffHunks(lines);
  expect(rest).toBe(0);
  expect(hunks).toHaveLength(1);
  expect(hunks[0]).toMatchObject({ skipped: 0, line: 1 });
  expect(hunks[0].rows.map((r) => r.op + r.text)).toEqual(['-a', '-b', '-c']);
});

// merge3: one test for each row of the text rules in section 14.2 of the plan.
const clean = (b: string, o: string, t: string) => {
  const m = merge3(b, o, t);
  expect(m.conflicts).toEqual([]);
  return m.text;
};

test('merge3: a run of lines changed on one side only is taken', () => {
  const b = 'a\nb\nc\nd\n';
  expect(clean(b, 'a\nB\nc\nd\n', b)).toBe('a\nB\nc\nd\n');
  expect(clean(b, b, 'a\nb\nc\nD\n')).toBe('a\nb\nc\nD\n');
  expect(clean(b, 'a\nd\n', b)).toBe('a\nd\n');
  expect(clean(b, b, 'a\nb\nx\ny\nc\nd\n')).toBe('a\nb\nx\ny\nc\nd\n');
});

test('merge3: changes in different places of both sides are all kept', () => {
  expect(clean('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n')).toBe('A\nb\nc\nd\nE\n');
  expect(clean('a\nb\nc\nd\ne\n', 'a\nb\nc\nd\ne\nf\n', 'z\na\nb\nc\nd\ne\n')).toBe(
    'z\na\nb\nc\nd\ne\nf\n',
  );
  expect(clean('a\nb\nc\nd\ne\n', 'a\nc\nd\ne\n', 'a\nb\nc\nd\nE\n')).toBe('a\nc\nd\nE\n');
});

test('merge3: the same change on both sides is taken once, not doubled or in conflict', () => {
  const b = 'a\nb\nc\n';
  expect(clean(b, 'a\nX\nc\n', 'a\nX\nc\n')).toBe('a\nX\nc\n');
  expect(clean(b, 'a\nc\n', 'a\nc\n')).toBe('a\nc\n');
  // The same line added at one place by both, with different edits elsewhere.
  expect(clean('a\nb\nc\n', 'a\nnew\nb\nc\n', 'a\nnew\nb\nC\n')).toBe('a\nnew\nb\nC\n');
});

test('merge3: two sentences of one long line, changed one on each side, merge by words', () => {
  const b = 'First we measure the tail. Then we fit a model. Finally we compare both.\n';
  const o = 'First we measure the tail latency. Then we fit a model. Finally we compare both.\n';
  const t = 'First we measure the tail. Then we fit a simpler model. Finally we compare both.\n';
  expect(clean(b, o, t)).toBe(
    'First we measure the tail latency. Then we fit a simpler model. Finally we compare both.\n',
  );
  // And with more lines around, one of which only one side changed.
  expect(clean(`x\n${b}y\n`, `X\n${o}y\n`, `x\n${t}y\n`)).toBe(
    'X\nFirst we measure the tail latency. Then we fit a simpler model. Finally we compare both.\ny\n',
  );
});

test('merge3: neighbouring lines edited in different words merge', () => {
  expect(clean('one two\nthree four\n', 'ONE two\nthree four\n', 'one two\nthree FOUR\n')).toBe(
    'ONE two\nthree FOUR\n',
  );
});

test('merge3: the same words changed differently on both sides are one small conflict', () => {
  const b = 'The cache holds 64 entries and evicts the oldest.\n';
  const o = 'The cache holds 128 entries and evicts the oldest.\n';
  const t = 'The cache holds 256 entries and evicts the newest.\n';
  const m = merge3(b, o, t);
  // Only the number conflicts; "oldest" changed on one side only is taken.
  expect(m.conflicts.map((c) => [c.kind, c.base, c.ours, c.theirs])).toEqual([
    ['both-changed', '64', '128', '256'],
  ]);
  expect(m.text).toBe('The cache holds 128 entries and evicts the newest.\n');
  expect(resolveMerge(m, ['theirs'])).toBe('The cache holds 256 entries and evicts the newest.\n');
});

test('merge3: a conflict says what each side had and where it sits', () => {
  const b = 'a\nthe cat sat\nz\n';
  const o = 'a\nthe dog sat\nz\n';
  const t = 'a\nthe fox sat\nz\n';
  const m = merge3(b, o, t);
  expect(m.text).toBe(o);
  expect(m.conflicts).toHaveLength(1);
  const [c] = m.conflicts;
  expect([c.base, c.ours, c.theirs]).toEqual(['cat', 'dog', 'fox']);
  expect(b.slice(c.baseStart, c.baseEnd)).toBe('cat');
  expect(o.slice(c.oursStart, c.oursEnd)).toBe('dog');
  expect(t.slice(c.theirsStart, c.theirsEnd)).toBe('fox');
  expect(m.text.slice(c.textStart, c.textStart + c.ours.length)).toBe('dog');
  expect(c.line).toBe(2);
  expect(m.chunks).toEqual(['a\nthe ', c, ' sat\nz\n']);
});

test('merge3: removed on one side and changed on the other is a conflict', () => {
  const b = 'a\nb\nc\n';
  const m = merge3(b, 'a\nc\n', 'a\nB\nc\n');
  expect(m.conflicts).toHaveLength(1);
  expect(m.conflicts[0]).toMatchObject({ kind: 'deleted-vs-changed', base: 'b\n', ours: '' });
  expect(m.conflicts[0].theirs).toBe('B\n');
  const n = merge3(b, 'a\nb2\nc\n', 'a\nc\n');
  expect(n.conflicts[0]).toMatchObject({ kind: 'deleted-vs-changed', theirs: '' });
  // Both removing the same line is no conflict.
  expect(clean(b, 'a\nc\n', 'a\nc\n')).toBe('a\nc\n');
});

test('merge3: different text added at the same place by both is a conflict; both kept on choice', () => {
  const m = merge3('a\nc\n', 'a\nX\nc\n', 'a\nY\nc\n');
  expect(m.conflicts).toHaveLength(1);
  expect(m.conflicts[0]).toMatchObject({
    kind: 'both-added',
    base: '',
    ours: 'X\n',
    theirs: 'Y\n',
  });
  expect(resolveMerge(m, ['both'])).toBe('a\nX\nY\nc\n');
  expect(resolveMerge(m, ['theirs'])).toBe('a\nY\nc\n');
  expect(resolveMerge(m, ['base'])).toBe('a\nc\n');
  expect(resolveMerge(m, [{ text: 'mine\n' }])).toBe('a\nmine\nc\n');
  expect(() => resolveMerge(m, [])).toThrow(/No choice/);
});

test('merge3: past the size guard the whole text is one conflict, ours in the text', () => {
  const b = numbered(30);
  const o = numbered(30, { 5: 'ours', 25: 'ours too' });
  const t = numbered(30, { 5: 'theirs', 25: 'theirs too' });
  const m = merge3(b, o, t, { maxCells: 1 });
  // diffLinesFar still finds the answer by Myers; only past FAR_EDITS does it give up.
  expect(m.conflicts.length).toBeGreaterThan(0);
  const many = (tag: string) =>
    Array.from({ length: FAR_EDITS + 5 }, (_, i) => `${tag}${i}`).join('\n');
  const big = merge3(many('b'), many('o'), many('t'));
  expect(big.conflicts).toHaveLength(1);
  expect(big.conflicts[0]).toMatchObject({ kind: 'too-large', base: many('b'), theirs: many('t') });
  expect(big.text).toBe(many('o'));
  expect(resolveMerge(big, ['theirs'])).toBe(many('t'));
  // Words of one stretch too far apart for the word table: that stretch of lines is the conflict.
  const w = merge3('one two three\n', 'one 2 three\n', 'one two 3\n', { wordCells: 0 });
  expect(w.conflicts).toHaveLength(1);
  expect(w.conflicts[0]).toMatchObject({ kind: 'both-changed', ours: 'one 2 three\n' });
  expect(clean('one two three\n', 'one 2 three\n', 'one two 3\n')).toBe('one 2 3\n');
});

test('merge3: bytes outside the changes are kept: CRLF, no final newline, empty texts', () => {
  expect(clean('a\r\nb\r\nc', 'a\r\nB\r\nc', 'a\r\nb\r\nC')).toBe('a\r\nB\r\nC');
  expect(clean('a\nb', 'a\nb\n', 'A\nb')).toBe('A\nb\n');
  expect(clean('a\nb\n', 'a\nb', 'A\nb\n')).toBe('A\nb');
  expect(clean('', 'x\n', '')).toBe('x\n');
  expect(clean('x\n', '', 'x\n')).toBe('');
  expect(clean('  a \t\n\n\n b\n', '  a \t\n\n\n B\n', '  A \t\n\n\n b\n')).toBe(
    '  A \t\n\n\n B\n',
  );
  // One side adds a final newline where the other changes the last line: both are kept.
  expect(clean('a\nb', 'a\nb\n', 'a\nB')).toBe('a\nB\n');
  expect(merge3('', 'x', 'y').conflicts[0].kind).toBe('both-added');
});

test('merge3: nothing changed on one side gives the other side; equal sides give that side', () => {
  const b = 'a\nb\nc';
  expect(merge3(b, b, b)).toEqual({ text: b, conflicts: [], chunks: [b] });
  expect(merge3(b, 'x', b).text).toBe('x');
  expect(merge3(b, b, 'y\n').text).toBe('y\n');
  expect(merge3(b, 'z', 'z')).toEqual({ text: 'z', conflicts: [], chunks: ['z'] });
});

test('merge3: seeded random texts keep every change and every byte', () => {
  const N = Number(process.env.FUZZ ?? 2000);
  const vocab = ['the', 'cache', '0.05', '\\cite{a}', 'x-y', 'é', 'and', 'a', '$x^2$'];
  for (let seed = 1; seed <= N; seed++) {
    let s = seed;
    const next = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s >>> 8) % n;
    };
    const eol = next(4) === 0 ? '\r\n' : '\n';
    const sentence = () =>
      Array.from({ length: 1 + next(14) }, () => vocab[next(vocab.length)]).join(' ');
    // A few unique lines (a long one among them) so that the edits below land where intended.
    const rows = Array.from({ length: next(10) }, (_, i) => `r${i} ${sentence()}`);
    const join = (r: string[]) => r.join(eol) + (r.length && next(3) ? eol : '');
    const base = join(rows);
    const edit = (r: string[], tag: string, only: (i: number) => boolean) =>
      r.map((x, i) => {
        if (!only(i)) return x;
        const k = next(4);
        return k === 0 ? x : k === 1 ? `${tag}${i} ${x}` : k === 2 ? `${x} ${tag}` : `${tag} ${i}`;
      });
    const fail = (why: string, more: unknown = '') =>
      new Error(`seed ${seed}: ${why} ${JSON.stringify([base, more])}`);

    // 1 and 2: one side unchanged, or both the same.
    const x = join(edit(rows, 'X', () => next(2) === 0));
    for (const m of [merge3(base, base, x), merge3(base, x, base), merge3(base, x, x)])
      if (m.text !== x || m.conflicts.length) throw fail('one side or both equal', x);

    // 3: edits on different lines (not neighbours) are all kept, without conflicts.
    const oddEven = (p: number) => (i: number) => i % 2 === p;
    const o = edit(rows, 'O', oddEven(0));
    const t = edit(rows, 'T', oddEven(1));
    const end = next(3) ? eol : '';
    const [bo, bt] = [o.join(eol) + end, t.join(eol) + end];
    const baseEnd = rows.join(eol) + end;
    const disjoint = merge3(baseEnd, bo, bt);
    const want = rows.map((r, i) => (i % 2 === 0 ? o[i] : t[i])).join(eol) + end;
    if (disjoint.conflicts.length || disjoint.text !== want) throw fail('disjoint edits', [bo, bt]);

    // 4: whatever the edits, ours chosen everywhere gives the text; the offsets say where.
    const oo = join(edit(rows, 'A', () => next(2) === 0));
    const tt = join(edit(rows, 'B', () => next(2) === 0));
    const m = merge3(base, oo, tt);
    if (
      resolveMerge(
        m,
        m.conflicts.map(() => 'ours'),
      ) !== m.text
    )
      throw fail('ours', [oo, tt]);
    if (m.chunks.filter((c) => typeof c !== 'string').length !== m.conflicts.length)
      throw fail('chunks', [oo, tt]);
    for (const c of m.conflicts) {
      const ok =
        base.slice(c.baseStart, c.baseEnd) === c.base &&
        oo.slice(c.oursStart, c.oursEnd) === c.ours &&
        tt.slice(c.theirsStart, c.theirsEnd) === c.theirs &&
        m.text.slice(c.textStart, c.textStart + c.ours.length) === c.ours;
      if (!ok) throw fail('offsets', [oo, tt, c]);
    }
    // 5: taking theirs everywhere is what merging the other way round with ours gives.
    const back = merge3(base, tt, oo);
    if (
      back.conflicts.length !== m.conflicts.length ||
      resolveMerge(
        back,
        back.conflicts.map(() => 'ours'),
      ) !==
        resolveMerge(
          m,
          m.conflicts.map(() => 'theirs'),
        )
    )
      throw fail('symmetry', [oo, tt]);
    // 6: with no conflicts, a side that changed nothing in the merge is the other side's text.
    if (!m.conflicts.length && (oo === base || tt === base)) {
      if (m.text !== (oo === base ? tt : oo)) throw fail('no conflicts, one side unchanged');
    }
  }
});
