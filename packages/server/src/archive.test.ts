import { crc32 } from 'node:zlib';
import { expect, test } from 'vitest';
import { checkPath, type Entry, LIMITS, readZip, writeZip } from './archive.ts';

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
function rawZip(files: { name: Buffer; data?: string; flags?: number; attr?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const plain = Buffer.from(file.data ?? tex);
    // A stored, encrypted entry carries a 12-byte header that yauzl counts in the compressed size.
    const enc = ((file.flags ?? 0) & 1) !== 0;
    const data = enc ? Buffer.concat([Buffer.alloc(12), plain]) : plain;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(file.flags ?? 0, 6);
    head.writeUInt32LE(crc32(plain), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(plain.length, 22);
    head.writeUInt16LE(file.name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    head.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(file.attr ?? 0, 38);
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

// Guard parts: the build leftovers stay refused. The .bbl cases fail without the fix.
test('a .bbl is a usable name, whatever its case or folder; other build output is not', () => {
  expect(checkPath('main.bbl')).toBe('');
  expect(checkPath('sub/Refs.BBL')).toBe('');
  for (const bad of ['main.blg', 'main.aux', 'main.synctex.gz', '.git/x.bbl', '__MACOSX/main.bbl'])
    expect(checkPath(bad), bad).toBe('it is not a file type a paper uses');
});

test('with a .bib in the archive, the .bbl is set aside and handed back, not lost', async () => {
  const { entries, skipped, bbl } = await read([
    f('main.tex'),
    f('main.bbl', '\\bibitem{k} A.'),
    f('x.bib', '@book{a,title={T}}'),
  ]);
  expect(bbl.map((e) => e.path)).toEqual(['main.bbl']);
  expect(entries.map((e) => e.path).sort()).toEqual(['main.tex', 'x.bib']);
  expect(skipped.map((s) => s.path)).toEqual(['main.bbl']);
});

const big = 'x'.repeat(5000);
const rawRead = (files: Parameters<typeof rawZip>[0]) => readZip(rawZip(files), small);

test('files of a type the import leaves out are not counted or size-checked', async () => {
  const { entries, skipped } = await read([
    f('main.tex'),
    f('a.tex'),
    ...Array.from({ length: 10 }, (_, i) => f(`.venv/lib/m${i}.pyc`, big)),
    f('data/raw.h5', big),
    f('talk.mp4', big),
  ]);
  expect(entries.map((e) => e.path).sort()).toEqual(['a.tex', 'main.tex']);
  expect(skipped).toHaveLength(12);
  expect(new Set(skipped.map((s) => s.reason))).toEqual(new Set(['not a file type a paper uses']));
});

test('a picture LaTeX cannot read, however large, is listed and not refused', async () => {
  const { entries, skipped } = await read([f('main.tex'), f('fig.tiff', big)]);
  expect(entries.map((e) => e.path)).toEqual(['main.tex']);
  expect(skipped).toEqual([{ path: 'fig.tiff', reason: expect.stringContaining('convert it') }]);
});

test('a symbolic link or encrypted entry of a type left out does not refuse the archive', async () => {
  const link = (0o120777 << 16) >>> 0;
  const r = await rawRead([
    { name: utf8('main.tex') },
    { name: utf8('Makefile'), data: '/etc/passwd', attr: link },
    { name: utf8('secret.docx'), flags: 1 },
  ]);
  expect(r.entries.map((e) => e.path)).toEqual(['main.tex']);
  expect(r.skipped.map((s) => s.path).sort()).toEqual(['Makefile', 'secret.docx']);
});

test('a symbolic link or encrypted entry of a wanted type is still refused', async () => {
  const link = (0o120777 << 16) >>> 0;
  await expect(
    rawRead([{ name: utf8('main.tex') }, { name: utf8('link.tex'), data: 'main.tex', attr: link }]),
  ).rejects.toThrow(/symbolic link/); // guard
  await expect(
    rawRead([{ name: utf8('main.tex') }, { name: utf8('x.tex'), flags: 1 }]),
  ).rejects.toThrow(/password/); // guard
});

test('an entry left out by type that appears twice is listed once', async () => {
  const r = await rawRead([
    { name: utf8('main.tex') },
    { name: utf8('notes.docx') },
    { name: utf8('notes.docx') },
  ]);
  expect(r.skipped.map((s) => s.path)).toEqual(['notes.docx']);
});

test('a left-out entry whose name cannot be shown imports and is not listed', async () => {
  const r = await rawRead([
    { name: utf8('main.tex') },
    { name: utf8(`node_modules/${'d'.repeat(260)}/x.map`) },
    { name: utf8('a\u0007b.docx'), flags: 0x800 },
  ]);
  expect(r.entries.map((e) => e.path)).toEqual(['main.tex']);
  expect(r.skipped).toEqual([]);
});

test('more wanted files than the limit still refuse the archive', async () => {
  await expect(read(['a.tex', 'b.tex', 'c.tex', 'd.tex'].map((p) => f(p)))).rejects.toThrow(
    /too many files/,
  ); // guard
});

test('left-out entries still count toward the entry bound', async () => {
  await expect(
    read([f('main.tex'), ...Array.from({ length: 40 }, (_, i) => f(`x/${i}.pyc`))]),
  ).rejects.toThrow(/too many files/); // guard
});
