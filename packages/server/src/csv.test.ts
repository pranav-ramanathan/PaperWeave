import { expect, test } from 'vitest';
import { asDate, asNumber, guessSchema, parseCsv } from './csv.ts';

test('quoted fields may hold delimiters, quotes and line breaks', () => {
  const csv = parseCsv(
    '﻿name,note,"latency, p95 (ms)"\r\n' +
      '"Smith, J.","said ""fine""",12.5\r\n' +
      'plain,"two\nlines",NA\r\n' +
      '\r\n' +
      '"",,3e1\n',
  );
  expect(csv.delimiter).toBe(',');
  expect(csv.header).toEqual(['name', 'note', 'latency, p95 (ms)']);
  expect(csv.rows).toEqual([
    ['Smith, J.', 'said "fine"', '12.5'],
    ['plain', 'two\nlines', 'NA'],
    ['', '', '3e1'],
  ]);
});

test('the delimiter is found, and a file that is not a table says why', () => {
  expect(parseCsv('a;b\n1,5;2\n').rows).toEqual([['1,5', '2']]);
  expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t');
  expect(parseCsv('only\n1\n2\n').rows).toEqual([['1'], ['2']]);
  for (const [text, why] of [
    ['', 'it is empty'],
    ['a,b\n1\n', 'row 2 has 1 fields where the first row has 2'],
    ['a,a\n1,2\n', 'two columns have the same name'],
    ['a,,c\n1,2,3\n', 'a column has no name in the first row'],
    ['a,b\n"open,2\n', 'a quoted field is never closed'],
    ['a,b\n"x"y,2\n', 'row 2 has text after a closing quote'],
  ])
    expect(() => parseCsv(text), text).toThrow(why);
});

test('numbers and dates are read as data writes them, and nothing is assumed', () => {
  for (const [value, want] of [
    ['3', 3],
    ['-0.5', -0.5],
    ['.5', 0.5],
    ['1e-3', 0.001],
    [' 42 ', 42],
  ] as const)
    expect(asNumber(value), value).toBe(want);
  for (const value of ['1,000', '12ms', '', 'NA', '0x1f', '1.2.3', 'Infinity'])
    expect(asNumber(value), value).toBeNull();
  expect(asDate('2024-03-01')).toBe('2024-03-01');
  expect(asDate('2024-03-01T12:30:00Z')).toBe('2024-03-01T12:30:00Z');
  for (const value of ['01/03/2024', '2024-13-01', 'March', '2024'])
    expect(asDate(value), value).toBeNull();
});

test('a schema is guessed for the author to check: types, units, gaps', () => {
  const csv = parseCsv(
    'writers,latency (ms),when,site\n1,4,2024-03-01,lab\n3,NA,2024-03-02,lab\n5,38,,field\n8,-,2024-03-04,\n',
  );
  expect(guessSchema(csv)).toEqual({
    rows: 4,
    // Only the spellings this file actually uses.
    missing: ['', 'NA', '-'],
    columns: [
      { name: 'writers', type: 'number', unit: '', missing: 0, examples: ['1', '3', '5'] },
      { name: 'latency (ms)', type: 'number', unit: 'ms', missing: 2, examples: ['4', '38'] },
      {
        name: 'when',
        type: 'date',
        unit: '',
        missing: 1,
        examples: ['2024-03-01', '2024-03-02', '2024-03-04'],
      },
      { name: 'site', type: 'text', unit: '', missing: 1, examples: ['lab', 'lab', 'field'] },
    ],
  });
  // One value that is not a number makes the column text: the author may know better.
  expect(guessSchema(parseCsv('n\n1\n2\nthree\n')).columns[0].type).toBe('text');
});
