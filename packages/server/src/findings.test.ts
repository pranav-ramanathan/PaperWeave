import { expect, test } from 'vitest';
import type { Finding } from './submit.ts';
import { byCause } from './findings.ts';

const warn = (message: string, extra: Partial<Finding> = {}): Finding => ({
  level: 'warning',
  kind: 'compiler',
  message,
  ...extra,
});

test('28 warnings with one message over 3 paths are one item with 28 places, in order', () => {
  const found = Array.from({ length: 28 }, (_, i) =>
    warn('Command \\small invalid in math mode', {
      fileId: `f${i % 3}`,
      path: `p${i % 3}.tex`,
      line: i + 1,
    }),
  );
  const out = byCause(found);
  expect(out).toHaveLength(1);
  expect(out[0].message).toBe('Command \\small invalid in math mode');
  expect(out[0].places).toHaveLength(28);
  expect(out[0].places[0]).toEqual({ fileId: 'f0', path: 'p0.tex', line: 1 });
  expect(out[0].places[27]).toEqual({ fileId: 'f0', path: 'p0.tex', line: 28 });
  expect(out[0].places.map((p) => p.line)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
});

test('the first finding of a cause carries its own place too', () => {
  const [one] = byCause([warn('a', { fileId: 'f', path: 'x.tex', line: 2 })]);
  expect(one).toEqual({
    level: 'warning',
    kind: 'compiler',
    message: 'a',
    fileId: 'f',
    path: 'x.tex',
    line: 2,
    places: [{ fileId: 'f', path: 'x.tex', line: 2 }],
  });
});

test('different messages stay apart', () => {
  const out = byCause([warn('a', { path: 'x.tex' }), warn('b', { path: 'x.tex' })]);
  expect(out.map((f) => f.message)).toEqual(['a', 'b']);
});

test('a problem and a warning with the same message stay apart', () => {
  const out = byCause([
    warn('a', { path: 'x.tex' }),
    { ...warn('a', { path: 'y.tex' }), level: 'problem' },
  ]);
  expect(out.map((f) => f.level)).toEqual(['warning', 'problem']);
});

test('the same kind matters too', () => {
  const out = byCause([warn('a'), { ...warn('a'), kind: 'label' }]);
  expect(out).toHaveLength(2);
});

test('an exact duplicate place is dropped', () => {
  const out = byCause([
    warn('a', { fileId: 'f', path: 'x.tex', line: 1 }),
    warn('a', { fileId: 'f', path: 'x.tex', line: 1 }),
    warn('a', { fileId: 'f', path: 'x.tex', line: 2 }),
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].places.map((p) => p.line)).toEqual([1, 2]);
});

test('a finding with no path has no places', () => {
  expect(byCause([warn('a')])[0].places).toEqual([]);
  const out = byCause([warn('a'), warn('a', { path: 'x.tex', line: 3 })]);
  expect(out).toHaveLength(1);
  expect(out[0].places).toEqual([{ fileId: undefined, path: 'x.tex', line: 3 }]);
});

test('a chart finding is never merged', () => {
  const chart = warn('Chart is stale', { chartId: 'c1' });
  const out = byCause([chart, { ...chart, chartId: 'c2' }, chart]);
  expect(out).toHaveLength(3);
  expect(out.every((f) => f.places.length === 0)).toBe(true);
  expect(out.map((f) => f.chartId)).toEqual(['c1', 'c2', 'c1']);
});

test('items keep the order of their first appearance', () => {
  const out = byCause([
    warn('b', { path: '1.tex', line: 1 }),
    warn('a', { path: '2.tex', line: 1 }),
    warn('b', { path: '3.tex', line: 1 }),
    warn('c', { path: '4.tex', line: 1 }),
  ]);
  expect(out.map((f) => f.message)).toEqual(['b', 'a', 'c']);
  expect(out[0].places.map((p) => p.path)).toEqual(['1.tex', '3.tex']);
});
