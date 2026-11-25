import { afterEach, expect, test } from 'vitest';
import { COMPACT_BYTES, COMPACT_ENTRIES, compactionDue } from './sync.ts';

afterEach(() => {
  delete process.env.SYNC_COMPACT_BYTES;
});

test('a log is due at 500 entries and not before', () => {
  expect(COMPACT_ENTRIES).toBe(500);
  expect(compactionDue(499, 0)).toBe(false);
  expect(compactionDue(500, 0)).toBe(true);
  expect(compactionDue(501, 0)).toBe(true);
});

test('a log is due at 16 MB past its first entry and not before', () => {
  expect(COMPACT_BYTES).toBe(16_000_000);
  expect(compactionDue(10, 15_999_999)).toBe(false);
  expect(compactionDue(10, 16_000_000)).toBe(true);
});

test('one large first entry on its own is not due, however large', () => {
  // The caller counts bytes after the first entry: a file imported at its largest is 0 of them.
  expect(compactionDue(1, 0)).toBe(false);
  expect(compactionDue(2, 0)).toBe(false);
});

test('both limits can be given, and the byte limit comes from SYNC_COMPACT_BYTES', () => {
  expect(compactionDue(5, 0, { entries: 5 })).toBe(true);
  expect(compactionDue(4, 0, { entries: 5 })).toBe(false);
  expect(compactionDue(2, 1000, { bytes: 1000 })).toBe(true);
  expect(compactionDue(2, 999, { bytes: 1000 })).toBe(false);
  process.env.SYNC_COMPACT_BYTES = '2000';
  expect(compactionDue(2, 1999)).toBe(false);
  expect(compactionDue(2, 2000)).toBe(true);
  // A setting that is not a positive whole number is the default.
  process.env.SYNC_COMPACT_BYTES = 'lots';
  expect(compactionDue(2, 15_999_999)).toBe(false);
  expect(compactionDue(2, 16_000_000)).toBe(true);
});
