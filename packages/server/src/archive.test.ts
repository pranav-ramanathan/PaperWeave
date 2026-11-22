import { expect, test } from 'vitest';
import { type Entry, LIMITS, readZip, writeZip } from './archive.ts';

const small = { ...LIMITS, files: 3, fileBytes: 1000, totalBytes: 1500, entries: 40 };
const tex = '\\documentclass{article}\\begin{document}x\\end{document}';
const f = (path: string, text = tex): Entry => ({ path, bytes: Buffer.from(text) });
const read = async (files: Entry[], limits = small) => readZip(await writeZip(files), limits);

test('.git does not count against the limits', async () => {
  const { entries, skipped } = await read([
    f('paper/main.tex'),
    f('paper/refs.bib', '@book{a,title={T}}'),
    ...Array.from({ length: 20 }, (_, i) => f(`paper/.git/objects/ab/${i}`, 'x')),
    f('paper/.git/objects/pack/p.pack', 'p'.repeat(5000)),
  ]);
  expect(entries.map((e) => e.path).sort()).toEqual(['paper/main.tex', 'paper/refs.bib']);
  expect(skipped).toEqual([]);
});

test('__MACOSX copies and .DS_Store do not count', async () => {
  const names = ['main.tex', 'a.tex', 'b.tex'];
  const { entries, skipped } = await read([
    ...names.map((n) => f(`paper/${n}`)),
    ...names.map((n) => f(`__MACOSX/paper/._${n}`, 'x')),
    f('paper/.DS_Store', 'x'),
  ]);
  expect(entries).toHaveLength(3);
  expect(skipped).toEqual([]);
});

test('the __MACOSX twin of a long name does not refuse the archive', async () => {
  const dir = `${'d'.repeat(70)}/${'e'.repeat(70)}/${'f'.repeat(60)}`;
  const name = `${'n'.repeat(45)}.tex`;
  const path = `${dir}/${name}`;
  const twin = `__MACOSX/${dir}/._${name}`;
  expect(path.length).toBeLessThanOrEqual(LIMITS.pathLength);
  expect(twin.length).toBeGreaterThan(LIMITS.pathLength);
  const { entries } = await read([f(path), f(twin, 'x')], LIMITS);
  expect(entries.map((e) => e.path)).toEqual([path]);
});

test('files of the paper still count', async () => {
  await expect(read([f('main.tex'), f('a.tex'), f('b.tex'), f('c.tex')])).rejects.toThrow(
    /too many files/,
  );
});

test('the number of entries is bounded, system folders included', async () => {
  await expect(
    read([f('main.tex'), ...Array.from({ length: 50 }, (_, i) => f(`.git/x${i}`, 'x'))], {
      ...small,
      files: 100,
    }),
  ).rejects.toThrow(/too many files/);
});
