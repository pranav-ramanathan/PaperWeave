import { crc32, gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { checkPath, type Entry, LIMITS, readTar, readZip, writeZip } from './archive.ts';
import { gnuLongName, paxHeader, tarBlock, tarFiles, tarOf } from './tarbuild.ts';

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

test("a './' prefix and doubled slashes in an entry name are removed", async () => {
  const r = await rawRead([
    { name: utf8('./main.tex') },
    { name: utf8('sec//a.tex') },
    { name: utf8('./figs/./b.tex') },
    { name: utf8('./') },
  ]);
  expect(r.entries.map((e) => e.path)).toEqual(['main.tex', 'sec/a.tex', 'figs/b.tex']);
});

test('two names that become the same file are refused', async () => {
  await expect(rawRead([{ name: utf8('./a.tex') }, { name: utf8('a.tex') }])).rejects.toThrow(
    /same file twice/,
  );
});

test('a cleaned name never climbs out or becomes absolute', async () => {
  for (const name of [
    '../a.tex',
    './../a.tex',
    'x/../../a.tex',
    '/a.tex',
    './/a.tex',
    '.\\..\\a.tex',
  ])
    await rawRead([{ name: utf8(name) }]).then(
      (r) =>
        expect(
          r.entries.every((e) => !e.path.startsWith('/') && !e.path.split('/').includes('..')),
        ).toBe(true),
      () => undefined,
    ); // guard: refused, or safe
});

// ---- tar and tar.gz

const refusal = async (bytes: Uint8Array, limits = small) => {
  try {
    await readZip(bytes, limits);
    return 'read';
  } catch (e) {
    return (e as Error).message;
  }
};
const tarOne = (name: string, data = tex) => tarBlock(name, data);

test('a tar.gz and a plain tar give the same entries as the same files zipped', async () => {
  const files = [
    f('paper/main.tex'),
    f('paper/sections/a.tex', '\\section{A} café'),
    f('paper/refs.bib', '@book{a,title={T}}'),
    { path: 'paper/figs/x.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1]) },
    f('paper/paperweave-review.json', '{}'),
    f('paper/notes.docx', 'left out'),
    f('paper/fig.svg', '<svg/>'),
    f('paper/main.bbl', 'bibliography'),
    f('paper/.git/HEAD', 'ref'),
  ];
  const zipped = await readZip(await writeZip(files), LIMITS);
  const tar = tarFiles(files);
  for (const archive of [tar, gzipSync(tar)]) {
    const got = await readZip(archive, LIMITS);
    expect(got).toEqual(zipped);
  }
  expect(zipped.entries.length).toBe(4);
  expect(zipped.bbl.map((e) => e.path)).toEqual(['paper/main.bbl']);
  expect(zipped.skipped.map((s) => s.path).sort()).toEqual([
    'paper/fig.svg',
    'paper/main.bbl',
    'paper/notes.docx',
  ]);
});

test('a tar is told by its first bytes, not its name, and a lone .gz is still refused', async () => {
  const tar = tarFiles([f('main.tex')]);
  expect((await readTar(gzipSync(tar))).entries.map((e) => e.path)).toEqual(['main.tex']);
  expect(await refusal(gzipSync(Buffer.from(tex)))).toBe(
    'This is a .gz, one compressed file. Unpack it and put it in a ZIP with the rest of the paper, then import that.',
  );
  // Refusals of a tar say "archive"; those of a ZIP still say "ZIP".
  expect(await refusal(tarOf([tarOne('a.tex'), tarOne('a.tex')]))).toBe(
    'This archive cannot be imported: it contains the same file twice.',
  );
  expect(await refusal(Buffer.from('not an archive at all'))).toBe(
    'This ZIP cannot be imported: it is not a readable ZIP file.',
  );
});

test('the ustar prefix is joined to the name, and GNU headers have none', async () => {
  const posix = tarOf([tarBlock('main.tex', tex, { prefix: 'paper/sections' })]);
  expect((await readZip(posix, small)).entries.map((e) => e.path)).toEqual([
    'paper/sections/main.tex',
  ]);
  const gnu = tarOf([tarBlock('main.tex', tex, { prefix: 'junk', format: 'gnu' })]);
  expect((await readZip(gnu, small)).entries.map((e) => e.path)).toEqual(['main.tex']);
});

test('names are cleaned as in a ZIP: ./ and // go, and the name is in NFC', async () => {
  const r = await readZip(tarOf([tarOne('./paper//main.tex'), tarOne('paper/café.tex')]), small);
  expect(r.entries.map((e) => e.path)).toEqual(['paper/main.tex', 'paper/café.tex']);
});

test('a name that climbs out or is absolute refuses the whole archive', async () => {
  for (const name of ['../x.tex', '/x.tex', 'a/../../x.tex', 'a/..', '../x.docx', '.git/../x']) {
    expect(await refusal(tarOf([tarOne('main.tex'), tarOne(name)])), name).toMatch(
      /^This archive cannot be imported: a file name in it is absolute or has \.\. in it/,
    );
  }
  // A name that only contains two dots is a name.
  expect((await readZip(tarOf([tarOne('a..b.tex')]), small)).entries).toHaveLength(1);
});

test('a name that is not UTF-8 refuses the whole archive', async () => {
  expect(
    await refusal(tarOf([tarBlock(Buffer.from([0x61, 0xff, 0xfe, 0x2e, 0x74, 0x65, 0x78]))])),
  ).toBe('This archive cannot be imported: a file name in it is not valid UTF-8.');
});

test('a link named as a file of a paper refuses the archive; one named as something else is skipped', async () => {
  for (const type of ['2', '1'])
    expect(
      await refusal(
        tarOf([tarOne('main.tex'), tarBlock('link.tex', '', { type, link: 'main.tex' })]),
      ),
    ).toBe(
      `This archive cannot be imported: it contains a ${type === '2' ? 'symbolic' : 'hard'} link.`,
    );
  const r = await readZip(
    tarOf([tarOne('main.tex'), tarBlock('fig.svg', '', { type: '2', link: '/etc/passwd' })]),
    small,
  );
  expect(r.entries.map((e) => e.path)).toEqual(['main.tex']);
  expect(r.skipped).toEqual([
    { path: 'fig.svg', reason: expect.stringContaining('LaTeX cannot use this picture') },
  ]);
});

test('a path of 300 characters works through a GNU long name and through pax', async () => {
  const path = `${'d'.repeat(100)}/${'e'.repeat(100)}/${'f'.repeat(80)}/main.tex`.padStart(
    300,
    'a',
  );
  expect(path).toHaveLength(300);
  const wide = { ...small, pathLength: 400 };
  for (const blocks of [
    [gnuLongName(path), tarBlock('long-name-stand-in.tex', tex)],
    [paxHeader({ path }), tarBlock('pax-stand-in.tex', tex)],
  ]) {
    const r = await readZip(gzipSync(tarOf([...blocks, tarOne('b.tex')])), wide);
    expect(r.entries.map((e) => e.path)).toEqual([path, 'b.tex']);
    // The ordinary limit on a path still holds for a name given this way.
    expect(await refusal(tarOf(blocks))).toBe(
      'This archive cannot be imported: a file name in it is not usable.',
    );
  }
});

test('a long name or pax path applies to the next entry only, and a pax size is read', async () => {
  const r = await readZip(
    tarOf([
      gnuLongName('first.tex'),
      tarBlock('x', tex),
      tarOne('second.tex'),
      paxHeader({ path: 'third.tex', size: String(tex.length) }),
      tarBlock('y', tex, { claim: 0 }),
    ]),
    small,
  );
  expect(r.entries.map((e) => [e.path, e.bytes.length])).toEqual([
    ['first.tex', tex.length],
    ['second.tex', tex.length],
    ['third.tex', tex.length],
  ]);
});

test('a bad checksum refuses the archive', async () => {
  const tar = Buffer.from(tarOf([tarOne('main.tex')]));
  tar[3] ^= 1; // a letter of the name, after the checksum was written
  expect(await refusal(tar)).toBe(
    'This archive cannot be imported: a header in it has a bad checksum.',
  );
  expect(await refusal(gzipSync(tar))).toBe(
    'This archive cannot be imported: a header in it has a bad checksum.',
  );
});

test('a truncated archive refuses the archive, plain or gzipped', async () => {
  const tar = tarOf([tarOne('main.tex', 'x'.repeat(900)), tarOne('b.tex')]);
  const cut =
    'This archive cannot be imported: it is cut short: it ends before its last file does.';
  expect(await refusal(tar.subarray(0, 512 + 300))).toBe(cut); // inside a file's data
  expect(await refusal(tar.subarray(0, 512 + 1024 + 100))).toBe(cut); // inside a header
  expect(await refusal(tar.subarray(0, 512 + 1024 + 512))).toBe(cut); // no end of archive
  // The gzip itself cut short is as damaged, whatever tar is in it.
  const gz = gzipSync(tar);
  expect(await refusal(gz.subarray(0, gz.length - 20))).toMatch(
    /^This archive cannot be imported: /,
  );
  expect(await refusal(gzipSync(tar.subarray(0, 512 + 300)))).toBe(cut);
});

test('a tar of an old kind, a sparse file and a base-256 size are refused with a sentence', async () => {
  expect(await refusal(tarOf([tarOne('a.tex'), tarBlock('b.tex', tex, { format: 'v7' })]))).toMatch(
    /^This archive cannot be imported: it is an old-style tar/,
  );
  expect(await refusal(tarOf([tarOne('a.tex'), tarBlock('b.tex', tex, { type: 'S' })]))).toMatch(
    /holds a sparse file/,
  );
  expect(await refusal(tarOf([paxHeader({ 'GNU.sparse.major': '1' }), tarOne('b.tex')]))).toMatch(
    /holds a sparse file/,
  );
  const wide = Buffer.alloc(12);
  wide[0] = 0x80;
  wide[11] = 5;
  expect(
    await refusal(tarOf([tarOne('a.tex'), tarBlock('b.tex', tex, { sizeField: wide })])),
  ).toMatch(/size in base-256/);
});

test('a file of the paper over a limit refuses the archive, as in a ZIP', async () => {
  expect(await refusal(tarOf([tarOne('a.tex', 'x'.repeat(1001))]))).toBe(
    'This archive cannot be imported: a.tex is too large.',
  );
  expect(await refusal(tarOf(['a', 'b', 'c', 'd'].map((n) => tarOne(`${n}.tex`))))).toBe(
    'This archive cannot be imported: it has too many files.',
  );
  expect(await refusal(tarOf(['a', 'b'].map((n) => tarOne(`${n}.tex`, 'x'.repeat(800)))))).toBe(
    'This archive cannot be imported: it unpacks to too much data.',
  );
  expect(await refusal(tarOf([tarOne('a.tex')]), { ...small, archiveBytes: 1000 })).toBe(
    'This archive cannot be imported: it is too large.',
  );
});

test('a gzip bomb of zeros stops at the cap on inflated bytes', async () => {
  const capped = { ...small, inflatedBytes: 1_000_000 };
  // Left-out data is inflated to be passed over, so only the inflated cap stops a bomb of it.
  const bomb = gzipSync(tarOf([tarBlock('notes.docx', Buffer.alloc(30_000_000))]));
  expect(bomb.length).toBeLessThan(100_000);
  expect(await refusal(bomb, capped)).toBe(
    'This archive cannot be imported: it unpacks to too much data.',
  );
  // The same as it ends, with the end of the archive early and a long tail of zeros after it.
  const tail = gzipSync(Buffer.concat([tarOf([tarOne('main.tex')]), Buffer.alloc(30_000_000)]));
  expect(await refusal(tail, capped)).toBe(
    'This archive cannot be imported: it unpacks to too much data.',
  );
  // And the same bomb under the ordinary cap is only read, not refused for its size.
  expect(await refusal(bomb, { ...small, inflatedBytes: 40_000_000 })).toBe('read');
  // Nothing but zeros is no tar at all.
  expect(await refusal(gzipSync(Buffer.alloc(30_000_000)), capped)).toMatch(/^This is a \.gz/);
});

test('.git entries count only towards the number of entries, in a tar too', async () => {
  const git = Array.from({ length: 20 }, (_, i) => tarOne(`paper/.git/objects/ab/${i}`, 'x'));
  const blocks = [
    tarOne('paper/main.tex'),
    tarOne('paper/refs.bib', '@book{a,title={T}}'),
    ...git,
    tarOne('paper/.git/objects/pack/p.pack', 'p'.repeat(5000)),
  ];
  const r = await readZip(gzipSync(tarOf(blocks)), small);
  expect(r.entries.map((e) => e.path).sort()).toEqual(['paper/main.tex', 'paper/refs.bib']);
  expect(r.skipped).toEqual([]);
  const many = Array.from({ length: 50 }, (_, i) => tarOne(`.git/x${i}`, 'x'));
  expect(await refusal(tarOf([tarOne('main.tex'), ...many]))).toBe(
    'This archive cannot be imported: it has too many files.',
  );
  // Unreadable names there are still not looked at.
  expect(
    (await readZip(tarOf([tarOne('main.tex'), tarOne('.git/a\u0001b')]), small)).entries,
  ).toHaveLength(1);
});
