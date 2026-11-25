import { expect, test } from 'vitest';
import { timeline, type TimelineRevision } from './timeline';

const rev = (
  number: number,
  at: string,
  more: Partial<TimelineRevision> = {},
): TimelineRevision => ({
  id: `id-${number}`,
  number,
  name: null,
  kind: 'auto',
  createdAt: at,
  createdBy: 'ana@example.org',
  restoredFrom: null,
  hasPdf: false,
  ...more,
});

const UTC = { timeZone: 'UTC' };
const shape = (rs: TimelineRevision[], opts = UTC) =>
  timeline(rs, opts).map((d) => [
    d.day,
    d.rows.map((r) => (r.type === 'run' ? `run ${r.count}` : `${r.type} ${r.revision.number}`)),
  ]);

test('no revisions, no days', () => {
  expect(timeline([], UTC)).toEqual([]);
});

test('days come newest first, and so do the rows in a day, whatever order they were given', () => {
  const rs = [
    rev(1, '2026-11-23T09:00:00Z', { kind: 'named', name: 'Submitted' }),
    rev(3, '2026-11-24T10:00:00Z', { kind: 'named', name: 'Review' }),
    rev(2, '2026-11-24T08:00:00Z', { kind: 'named', name: 'Draft' }),
  ];
  expect(shape(rs)).toEqual([
    ['2026-11-24', ['named 3', 'named 2']],
    ['2026-11-23', ['named 1']],
  ]);
});

test('consecutive automatic revisions are one row with count, range, authors and files', () => {
  const rs = [
    rev(5, '2026-11-24T14:12:00Z', { createdBy: 'bo@example.org', files: ['main.tex'] }),
    rev(4, '2026-11-24T13:40:00Z', { files: ['refs.bib', 'main.tex'] }),
    rev(3, '2026-11-24T13:20:00Z', { createdBy: null }),
  ];
  const [day] = timeline(rs, UTC);
  expect(day.rows).toHaveLength(1);
  expect(day.rows[0]).toMatchObject({
    type: 'run',
    id: 'run-5-3',
    count: 3,
    from: new Date('2026-11-24T13:20:00Z'),
    to: new Date('2026-11-24T14:12:00Z'),
    at: new Date('2026-11-24T14:12:00Z'),
    authors: ['bo@example.org', 'ana@example.org'],
    files: ['main.tex', 'refs.bib'],
    began: [],
  });
  expect((day.rows[0] as { revisions: TimelineRevision[] }).revisions.map((r) => r.number)).toEqual(
    [5, 4, 3],
  );
});

test('a named revision, a restore or a merge ends a run and is a row of its own', () => {
  const rs = [
    rev(7, '2026-11-24T16:00:00Z'),
    rev(6, '2026-11-24T15:00:00Z', { kind: 'merge', name: 'Merged' }),
    rev(5, '2026-11-24T14:00:00Z'),
    rev(4, '2026-11-24T13:00:00Z'),
    rev(3, '2026-11-24T12:00:00Z', { kind: 'restore', restoredFrom: 1 }),
    rev(2, '2026-11-24T11:00:00Z', { kind: 'named', name: 'With review' }),
    rev(1, '2026-11-24T10:00:00Z'),
  ];
  expect(shape(rs)).toEqual([
    ['2026-11-24', ['run 1', 'merge 6', 'run 2', 'restore 3', 'named 2', 'run 1']],
  ]);
});

test("a run does not go across midnight in the viewer's time zone", () => {
  const rs = [
    rev(3, '2026-11-24T00:30:00Z'),
    rev(2, '2026-11-23T23:50:00Z'),
    rev(1, '2026-11-23T23:10:00Z'),
  ];
  expect(shape(rs)).toEqual([
    ['2026-11-24', ['run 1']],
    ['2026-11-23', ['run 2']],
  ]);
  // In Los Angeles (UTC-8) all three are on the 23rd, in one run.
  expect(shape(rs, { timeZone: 'America/Los_Angeles' })).toEqual([['2026-11-23', ['run 3']]]);
  // In Tokyo (UTC+9) they are all on the 24th.
  expect(shape(rs, { timeZone: 'Asia/Tokyo' })).toEqual([['2026-11-24', ['run 3']]]);
});

test('the day follows the zone and its daylight saving, not the machine', () => {
  // 2026-03-29 01:30 UTC is 03:30 in Berlin (summer time began that night), 2026-03-28 in New York.
  const rs = [rev(1, '2026-03-29T01:30:00Z', { kind: 'named', name: 'x' })];
  expect(shape(rs, { timeZone: 'Europe/Berlin' })[0][0]).toBe('2026-03-29');
  expect(shape(rs, { timeZone: 'America/New_York' })[0][0]).toBe('2026-03-28');
});

test('dates from the database driver work as strings do', () => {
  const rs = [rev(1, '', { createdAt: new Date('2026-11-24T10:00:00Z') })];
  expect(shape(rs)).toEqual([['2026-11-24', ['run 1']]]);
});

test('where a version began is marked on the row holding that revision', () => {
  const rs = [
    rev(4, '2026-11-24T14:00:00Z'),
    rev(3, '2026-11-24T13:00:00Z'),
    rev(2, '2026-11-24T12:00:00Z', { kind: 'named', name: 'Submitted' }),
    rev(1, '2026-11-24T11:00:00Z'),
  ];
  const starts = [
    { revisionId: 'id-3', name: 'camera-ready' },
    { revisionId: 'id-2', name: 'reviewer B' },
    { revisionId: 'elsewhere', name: 'not here' },
  ];
  const [day] = timeline(rs, { ...UTC, starts });
  expect(day.rows.map((r) => r.began.map((s) => s.name))).toEqual([
    ['camera-ready'],
    ['reviewer B'],
    [],
  ]);
  expect(timeline(rs, UTC)[0].rows.every((r) => r.began.length === 0)).toBe(true);
});

test('the input is not changed, and the same input gives the same timeline', () => {
  const rs = [rev(1, '2026-11-23T10:00:00Z'), rev(2, '2026-11-24T10:00:00Z')];
  const copy = structuredClone(rs);
  expect(timeline(rs, UTC)).toEqual(timeline(rs, UTC));
  expect(rs).toEqual(copy);
});
