import { expect, test } from 'vitest';
import { checkChart, type ChartSpec, describeChart, vegaLite } from './charts.ts';
import type { Column } from './data.ts';

const columns: Column[] = [
  { name: 'day', type: 'date', unit: '' },
  { name: 'latency, p95 (ms)', type: 'number', unit: 'ms' },
  { name: 'writers', type: 'number', unit: 'people' },
  { name: 'site', type: 'text', unit: '' },
];
const rows = [
  ['2024-03-01', 9, 1, 'Lab, north'],
  ['2024-03-02 12:30', null, 3, 'Lab, north'],
  ['2024-03-03', 38, 5, 'Field'],
  [null, 40, 8, 'Field'],
  ['2024-03-05', 41, null, null],
];
const base = { series: '', combine: '', gaps: 'break', title: '' };
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? `unexpected: ${(err as Error).message}`;
  }
};
type Drawn = {
  data: { values: Record<string, unknown>[] };
  mark: Record<string, unknown>;
  encoding: Record<string, Record<string, unknown>>;
};
const draw = (spec: ChartSpec, table = { columns, rows }) => {
  const { vl, leftOut } = vegaLite(spec, table);
  return { ...(vl as unknown as Drawn), leftOut };
};

test('a chart is checked against the columns of its data file', () => {
  const ok = checkChart(
    { ...base, kind: 'line', x: 'day', y: 'latency, p95 (ms)', series: 'site', title: ' Week ' },
    columns,
  );
  expect(ok).toEqual({
    kind: 'line',
    x: 'day',
    y: 'latency, p95 (ms)',
    series: 'site',
    combine: null,
    gaps: 'break',
    title: 'Week',
  });
  for (const wrong of [
    { kind: 'pie', x: 'day', y: 'writers' },
    { kind: 'line', x: 'nope', y: 'writers' },
    { kind: 'line', x: 'day', y: 'site' },
    { kind: 'line', x: 'writers', y: 'writers' },
    // Text along the bottom is for bars only.
    { kind: 'scatter', x: 'site', y: 'writers' },
    { kind: 'line', x: 'day', y: 'writers', series: 'latency, p95 (ms)' },
    { kind: 'bar', x: 'site', y: 'writers', series: 'site' },
    { kind: 'scatter', x: 'day', y: 'writers', combine: 'mean' },
    { kind: 'bar', x: 'site', y: 'writers', combine: 'median' },
    { kind: 'bar', x: 'site', y: 'writers', title: 'x'.repeat(121) },
  ])
    expect(
      code(() => checkChart({ ...base, ...wrong }, columns)),
      JSON.stringify(wrong),
    ).toBe('invalid_input');
  expect(describeChart(ok, columns)).toBe('Line chart of latency, p95 (ms) against day, by site.');
});

test('units go into the axis titles, once', () => {
  const spec = checkChart(
    { ...base, kind: 'scatter', x: 'writers', y: 'latency, p95 (ms)' },
    columns,
  );
  const { encoding } = draw(spec);
  expect(encoding.x.title).toBe('writers (people)');
  // The name already says its unit.
  expect(encoding.y.title).toBe('latency, p95 (ms)');
  const mean = draw(
    checkChart({ ...base, kind: 'bar', x: 'site', y: 'writers', combine: 'mean' }, columns),
  );
  expect(mean.encoding.y).toMatchObject({ title: 'mean of writers (people)', aggregate: 'mean' });
});

test('rows without a value are left out and counted, except where a line can show the gap', () => {
  const scatter = draw(
    checkChart({ ...base, kind: 'scatter', x: 'day', y: 'latency, p95 (ms)' }, columns),
  );
  // No y in one row, no x in another.
  expect(scatter.leftOut).toBe(2);
  expect(scatter.data.values.map((v) => v.y)).toEqual([9, 38, 41]);

  const line = draw(
    checkChart({ ...base, kind: 'line', x: 'day', y: 'latency, p95 (ms)' }, columns),
  );
  expect(line.leftOut).toBe(1);
  expect(line.data.values.map((v) => v.y)).toEqual([9, null, 38, 41]);
  expect(line.mark.invalid).toBe('break-paths-show-path-domains');

  const joined = draw(
    checkChart({ ...base, kind: 'line', x: 'day', y: 'latency, p95 (ms)', gaps: 'join' }, columns),
  );
  expect(joined.leftOut).toBe(2);
  expect(joined.mark.invalid).toBeUndefined();
  // A row with no group cannot be placed in one.
  expect(
    draw(checkChart({ ...base, kind: 'line', x: 'day', y: 'writers', series: 'site' }, columns))
      .leftOut,
  ).toBe(2);
});

test('dates are drawn where they were written, whatever the clock of the machine', () => {
  const { data, encoding } = draw(
    checkChart({ ...base, kind: 'line', x: 'day', y: 'writers' }, columns),
  );
  expect(data.values.map((v) => v.x)).toEqual([
    '2024-03-01',
    '2024-03-02T12:30Z',
    '2024-03-03',
    // No value here: kept, so that the line breaks.
    '2024-03-05',
  ]);
  expect(encoding.x).toMatchObject({ type: 'temporal', scale: { type: 'utc' } });
});

test('a chart that would mislead is refused', () => {
  // Two rows for one bar, and nothing said about how to combine them.
  const bar = checkChart({ ...base, kind: 'bar', x: 'site', y: 'writers' }, columns);
  expect(code(() => draw(bar))).toBe('invalid_input');
  expect(code(() => draw({ ...bar, combine: 'sum' }))).toBe('ok');
  // Too many groups to tell apart.
  const many = {
    columns,
    rows: Array.from({ length: 9 }, (_, i) => ['2024-03-01', i, i, `g${i}`]),
  };
  const grouped = checkChart(
    { ...base, kind: 'scatter', x: 'writers', y: 'latency, p95 (ms)', series: 'site' },
    columns,
  );
  expect(code(() => draw(grouped, many))).toBe('invalid_input');
  // Nothing to draw.
  expect(code(() => draw(grouped, { columns, rows: [['2024-03-01', null, 1, 'a']] }))).toBe(
    'invalid_input',
  );
  // A column the chart uses is gone from the file.
  expect(code(() => draw(grouped, { columns: columns.slice(0, 3), rows: [] }))).toBe(
    'invalid_input',
  );
});
