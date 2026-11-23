import { crc32 } from 'node:zlib';
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

/** A ZIP of stored files whose names are given as bytes, with the flags (bit 11 = UTF-8) as given. */
function rawZip(files: { name: Buffer; data?: string; flags?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.from(file.data ?? tex);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(file.flags ?? 0, 6);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(file.name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    head.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    locals.push(head, file.name, data);
    central.push(entry, file.name);
    offset += 30 + file.name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
const utf8 = (s: string) => Buffer.from(s, 'utf8');
const NFC = 'figs/Übersicht.png';
const NFD = 'figs/Übersicht.png';

test('a decomposed name in a ZIP is read composed', async () => {
  const { entries } = await read([f('main.tex'), f(NFD, 'x')]);
  expect(entries.map((e) => e.path).sort()).toEqual([NFC, 'main.tex']);
});

test.each([
  ['decomposed', NFD],
  ['composed', NFC],
])('a %s UTF-8 name without the UTF-8 flag is read as UTF-8', async (_kind, name) => {
  const { entries } = await readZip(
    rawZip([{ name: utf8('main.tex') }, { name: utf8(name), data: 'x' }]),
    small,
  );
  expect(entries.map((e) => e.path).sort()).toEqual([NFC, 'main.tex']);
});

test('a CP437 name without the UTF-8 flag keeps its CP437 reading', async () => {
  // 0x82 is e-acute in CP437, and by itself is not UTF-8.
  const { entries } = await readZip(
    rawZip([{ name: Buffer.from([0x6d, 0x82, 0x2e, 0x74, 0x65, 0x78]) }]),
    small,
  );
  expect(entries.map((e) => e.path)).toEqual(['mé.tex']);
});

test('names that are the same once composed are the same file twice', async () => {
  await expect(
    readZip(
      rawZip([
        { name: utf8('Ü.tex'), flags: 0x800 },
        { name: utf8('Ü.tex'), flags: 0x800 },
      ]),
      small,
    ),
  ).rejects.toThrow(/same file twice/);
});
