import { expect, test } from 'vitest';
import { contentDisposition, heldLine } from './download.ts';

const parts = (header: string) => {
  const m = /^(\w+); filename="([^"]*)"; filename\*=UTF-8''(\S+)$/.exec(header)!;
  return { disposition: m[1], plain: m[2], full: decodeURIComponent(m[3]) };
};

test('a name keeps its letters in filename*, and has an ASCII fallback', () => {
  expect(parts(contentDisposition('Étude sur les réseaux', 'zip'))).toEqual({
    disposition: 'attachment',
    plain: '_tude sur les r_seaux.zip',
    full: 'Étude sur les réseaux.zip',
  });
  // Nothing but underscores would say nothing: the fallback is "paper".
  expect(parts(contentDisposition('机器学习综述', 'zip'))).toMatchObject({
    plain: 'paper.zip',
    full: '机器学习综述.zip',
  });
  expect(parts(contentDisposition('a "quoted" name', 'pdf'))).toMatchObject({
    plain: 'a _quoted_ name.pdf',
    full: 'a "quoted" name.pdf',
  });
  const slashed = contentDisposition('a/b: c', 'zip');
  expect(parts(slashed)).toMatchObject({ plain: 'a_b_ c.zip', full: 'a/b: c.zip' });
  expect(slashed).not.toMatch(/filename\*=[^;]*[/:]/);
  expect(
    parts(contentDisposition('Étude', 'pdf', { disposition: 'inline', suffix: ' r3' })),
  ).toEqual({ disposition: 'inline', plain: '_tude r3.pdf', full: 'Étude r3.pdf' });
  expect(parts(contentDisposition('机器学习综述', 'zip', { suffix: ' r2' }))).toMatchObject({
    plain: 'paper r2.zip',
    full: '机器学习综述 r2.zip',
  });
  expect(parts(contentDisposition('', 'pdf')).plain).toBe('paper.pdf');
  expect(contentDisposition("it's (1)*", 'zip')).toContain("''it%27s%20%281%29%2A.zip");
});

test('a version is named after the paper, then the version, then the revision', () => {
  expect(
    parts(contentDisposition('Tail latency', 'zip', { version: 'camera-ready', suffix: ' r9' })),
  ).toEqual({
    disposition: 'attachment',
    plain: 'Tail latency (camera-ready) r9.zip',
    full: 'Tail latency (camera-ready) r9.zip',
  });
  // A long paper name is cut; the version after it is not.
  const long = parts(
    contentDisposition('x'.repeat(200), 'pdf', { version: 'reviewer B', suffix: ' r2' }),
  );
  expect(long.full).toBe(`${'x'.repeat(80)} (reviewer B) r2.pdf`);
  // Letters outside ASCII stay in filename*, and are `_` in the plain name.
  expect(parts(contentDisposition('Étude', 'pdf', { version: 'révision' }))).toMatchObject({
    plain: '_tude (r_vision).pdf',
    full: 'Étude (révision).pdf',
  });
  // A paper is named as before, with no version or an empty one.
  for (const version of [undefined, null, ''])
    expect(contentDisposition('Étude', 'zip', { version })).toBe(
      contentDisposition('Étude', 'zip'),
    );
});

test('the line about held files names every one', () => {
  expect(heldLine([])).toBeNull();
  expect(heldLine(['data.csv', 'b/c.csv'])).toBe(
    'Not in these downloads: data.csv, b/c.csv (marked as data to keep back).',
  );
});
