import { type ChartSpec, type Column, vegaLite } from '@paperweave/server';
import * as vega from 'vega';
import { compile } from 'vega-lite';
import { expect, test } from 'vitest';

const columns: Column[] = [
  { name: 'year', type: 'number', unit: '' },
  { name: 'acc', type: 'number', unit: '%' },
  { name: 'model', type: 'text', unit: '' },
  { name: 'day', type: 'date', unit: '' },
];
const rows = [2019, 2020, 2021, 2022].flatMap((year, i) => [
  [year, 60 + i * 2, 'a', `2024-03-0${i + 1}`],
  [year, 70 + i * 2, 'b', `2024-03-0${i + 1}`],
]);
const table = { columns, rows };
const base = { series: null, combine: null, gaps: 'break', title: '' } as const;

/** Draw as the worker does, and report what Vega-Lite said on the way. */
async function svgOf(spec: ChartSpec) {
  const warnings: string[] = [];
  const logger = {
    level: () => logger,
    warn: (...a: unknown[]) => warnings.push(a.join(' ')),
    info: () => logger,
    debug: () => logger,
    error: (...a: unknown[]) => warnings.push(a.join(' ')),
  };
  const { vl } = vegaLite(spec, table);
  const view = new vega.View(vega.parse(compile(vl as never, { logger } as never).spec), {
    renderer: 'none',
  });
  const svg = await view.toSVG();
  view.finalize();
  return { svg, warnings };
}
const texts = (svg: string) =>
  [...svg.matchAll(/<text[^>]*>(?:<tspan[^>]*>)?([^<]*)/g)].map((m) => m[1]);
const bars = (svg: string) =>
  [...svg.matchAll(/<path[^>]*aria-roledescription="bar"[^>]*>/g)].map((m) => m[0]);

test('a line over years labels them as years', async () => {
  const { svg } = await svgOf({ ...base, kind: 'line', x: 'year', y: 'acc', series: 'model' });
  const labels = texts(svg);
  for (const year of ['2019', '2020', '2021', '2022']) expect(labels).toContain(year);
  expect(labels.filter((l) => l.includes(',') || l.includes('.5'))).toEqual([]);
});

test('a scatter over years starts at the first year', async () => {
  const { svg } = await svgOf({ ...base, kind: 'scatter', x: 'year', y: 'acc' });
  // The y axis has a 0; the year axis does not run from it.
  expect(texts(svg).filter((l) => /^(2019|2020|2021|2022)$/.test(l))).toHaveLength(4);
  expect(texts(svg).filter((l) => l.includes('200'))).toEqual([]);
  const xs = [
    ...svg.matchAll(/aria-roledescription="point"[^>]*transform="translate\(([\d.]+)/g),
  ].map((m) => Number(m[1]));
  expect(xs.length).toBeGreaterThan(0);
  expect(Math.min(...xs)).toBeLessThan(10);
  expect(Math.max(...xs)).toBeGreaterThan(350);
});

test('a grouped bar over years puts the bars side by side', async () => {
  const { svg, warnings } = await svgOf({
    ...base,
    kind: 'bar',
    x: 'year',
    y: 'acc',
    series: 'model',
  });
  expect(warnings.filter((w) => w.includes('xOffset'))).toEqual([]);
  const labels = texts(svg);
  expect(labels.filter((l) => /^\d{4}$/.test(l))).toEqual(['2019', '2020', '2021', '2022']);
  const ticks = labels.filter((l) => /^\d{1,3}$/.test(l)).map(Number);
  expect(Math.max(...ticks)).toBe(80);
  const widths = bars(svg).map((b) => Number(/d="[^"]*?h([\d.]+)/.exec(b)?.[1]));
  expect(widths).toHaveLength(8);
  for (const w of widths) expect(w).toBeGreaterThan(20);
});

test('a grouped bar over dates is labelled with the dates as written', async () => {
  const { svg, warnings } = await svgOf({
    ...base,
    kind: 'bar',
    x: 'day',
    y: 'acc',
    series: 'model',
  });
  expect(warnings.filter((w) => w.includes('xOffset'))).toEqual([]);
  expect(texts(svg).filter((l) => /^\d{4}-/.test(l))).toEqual([
    '2024-03-01',
    '2024-03-02',
    '2024-03-03',
    '2024-03-04',
  ]);
});

test('a line over whole days shows no hours', async () => {
  const { svg } = await svgOf({ ...base, kind: 'line', x: 'day', y: 'acc', series: 'model' });
  expect(texts(svg).filter((l) => /AM|PM/.test(l))).toEqual([]);
});
