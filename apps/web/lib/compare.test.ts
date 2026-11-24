import type { Revision } from '@paperweave/server';
import { expect, test } from 'vitest';
import { called, comparison, NOW, since } from './compare';

const rev = (number: number, more: Partial<Revision> = {}): Revision => ({
  id: `id-${number}`,
  number,
  name: null,
  kind: 'auto',
  createdAt: '2026-11-24T14:02:31.000Z',
  createdBy: 'ana@example.org',
  restoredFrom: null,
  hasPdf: false,
  ...more,
});
/** Newest first, as the page has them: `named` are numbers of revisions somebody named. */
const history = (newest: number, oldest: number, named: number[] = []) =>
  Array.from({ length: newest - oldest + 1 }, (_, i) => newest - i).map((n) =>
    rev(n, named.includes(n) ? { kind: 'named', name: `Named ${n}` } : {}),
  );

test('a comparison starts at the newest revision somebody named, however many builds came after', () => {
  // Sent to a co-author at 12; an hour of writing made a hundred more.
  const list = [...history(112, 63), rev(12, { kind: 'named', name: 'Sent to Ana' })];
  expect(since(list, true)).toBe('id-12');
  expect(since(list, false)).toBe('id-12');
  // Of two named ones, the later.
  expect(since(history(30, 1, [4, 17]), true)).toBe('id-17');
  // A restore is a moment people know too.
  expect(since([rev(9), rev(8, { kind: 'restore', restoredFrom: 3 }), rev(7)], true)).toBe('id-8');
});

test('with nothing named a comparison starts at the oldest revision listed', () => {
  expect(since(history(60, 11), true)).toBe('id-11');
  expect(since(history(60, 11), false)).toBe('id-11');
});

test('the newest revision is where a comparison starts only when it can end at the paper as it is now', () => {
  const list = history(20, 15, [20, 16]);
  // Someone who may write: from the revision just named to now says what was typed since.
  expect(since(list, true)).toBe('id-20');
  // Someone who may not: it ends at 20, so it starts at the named one before.
  expect(since(list, false)).toBe('id-16');
  expect(since(history(20, 15, [20]), false)).toBe('id-15');
});

test('a paper with one revision, or none', () => {
  expect(since([rev(1)], true)).toBe('id-1');
  expect(since([rev(1)], false)).toBe('id-1');
  expect(since([], true)).toBeUndefined();
  expect(since([], false)).toBeUndefined();
});

test('a choice names the revision as the table does, with when it was made', () => {
  expect(called(rev(7))).toBe('7. Unnamed, 2026-11-24 14:02 UTC');
  expect(called(rev(8, { kind: 'named', name: 'Sent to Ana' }))).toBe(
    '8. Sent to Ana, 2026-11-24 14:02 UTC',
  );
  expect(called(rev(9, { kind: 'restore', restoredFrom: 3 }))).toBe(
    '9. Restore of revision 3, 2026-11-24 14:02 UTC',
  );
  // The database hands the time over as a Date; the type says string.
  expect(called(rev(7, { createdAt: new Date('2026-01-02T03:04:05Z') as unknown as string }))).toBe(
    '7. Unnamed, 2026-01-02 03:04 UTC',
  );
});

test('a long name is cut short in a choice, so that the list of choices stays narrow', () => {
  const long = called(rev(3, { kind: 'named', name: 'x'.repeat(200) }));
  expect(long).toBe(`3. ${'x'.repeat(40)}…, 2026-11-24 14:02 UTC`);
  expect(called(rev(3, { kind: 'named', name: 'y'.repeat(40) }))).toContain(`${'y'.repeat(40)},`);
});

test('the comparison is the page of the later revision, from the earlier', () => {
  expect(comparison('p', 'a', 'b')).toBe('/projects/p/revisions/b/diff/a');
  expect(NOW).toBe('now');
});
