// A tar written byte by byte, for tests: so that they can say things a well-behaved writer never
// would, and never shell out to `tar`. Not used by the service.

const BLOCK = 512;

export type TarOptions = {
  /** The header's type byte: '0' a file, '2' a symbolic link, '1' a hard link, '5' a folder, 'S' sparse. */
  type?: string;
  /** What a link points at. */
  link?: string;
  /** ustar's prefix field, joined to the name with a "/". */
  prefix?: string;
  /** The magic: POSIX "ustar\0" and version "00" (the default), GNU "ustar  \0", or none (old V7). */
  format?: 'posix' | 'gnu' | 'v7';
  /** Written into the size field as it is (for base-256, or a size that does not match the data). */
  sizeField?: Buffer;
  /** The size to state, if it is not the length of the data. */
  claim?: number;
};

const octalField = (n: number, length: number) =>
  Buffer.from(n.toString(8).padStart(length - 1, '0') + '\0', 'latin1');

/** One entry: a 512-byte header, then the data padded to a whole block. */
export function tarBlock(
  name: string | Buffer,
  data: string | Buffer = '',
  o: TarOptions = {},
): Buffer {
  const body = Buffer.from(data);
  const head = Buffer.alloc(BLOCK);
  Buffer.from(name).copy(head, 0, 0, 100);
  octalField(0o644, 8).copy(head, 100);
  octalField(0, 8).copy(head, 108);
  octalField(0, 8).copy(head, 116);
  (
    o.sizeField ?? octalField(o.claim ?? (o.type === '2' || o.type === '1' ? 0 : body.length), 12)
  ).copy(head, 124);
  octalField(0, 12).copy(head, 136);
  head.fill(0x20, 148, 156);
  head.write(o.type ?? '0', 156, 'latin1');
  if (o.link) Buffer.from(o.link).copy(head, 157, 0, 100);
  const format = o.format ?? 'posix';
  if (format === 'posix') {
    head.write('ustar\0', 257, 'latin1');
    head.write('00', 263, 'latin1');
    if (o.prefix) Buffer.from(o.prefix).copy(head, 345, 0, 155);
  } else if (format === 'gnu') head.write('ustar  \0', 257, 'latin1');
  let sum = 0;
  for (const b of head) sum += b;
  head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  const data512 = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK);
  body.copy(data512);
  return Buffer.concat([head, data512]);
}

/** A GNU long name: the entry after it takes this name. */
export const gnuLongName = (name: string) => tarBlock('././@LongLink', name + '\0', { type: 'L' });

/** A pax extended header: the entry after it takes these fields. */
export function paxHeader(fields: Record<string, string>) {
  const records = Object.entries(fields).map(([key, value]) => {
    const rest = Buffer.from(` ${key}=${value}\n`);
    // The length counts its own digits.
    let length = rest.length + 1;
    while (String(length).length + rest.length !== length)
      length = String(length).length + rest.length;
    return Buffer.concat([Buffer.from(String(length)), rest]);
  });
  return tarBlock('PaxHeader/x', Buffer.concat(records), { type: 'x' });
}

/** Blocks as one tar, ended the way tar ends one: two empty blocks. */
export const tarOf = (blocks: Buffer[], ended = true): Buffer =>
  Buffer.concat([...blocks, ...(ended ? [Buffer.alloc(BLOCK * 2)] : [])]);

/** The files as a plain ustar tar. */
export const tarFiles = (files: { path: string; bytes: Uint8Array }[]): Buffer =>
  tarOf(files.map((f) => tarBlock(f.path, Buffer.from(f.bytes))));
