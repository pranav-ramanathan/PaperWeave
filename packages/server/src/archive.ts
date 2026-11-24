// Reading and writing project archives (ZIP, and tar or tar.gz for reading). An uploaded archive
// is untrusted: nothing in it is believed until checked, and nothing is written anywhere by its
// own say-so.
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { AppError } from './errors.ts';

export const LIMITS = {
  archiveBytes: 100_000_000,
  files: 2_000,
  /** Every entry in the archive, system folders included: entries left out (system folders, files of a type no paper uses) are never read, only counted here. */
  entries: 50_000,
  fileBytes: 50_000_000,
  totalBytes: 300_000_000,
  /**
   * The most a .tar.gz may unpack to, everything in it counted: headers, padding, and the entries
   * that are left out, which are inflated all the same before they can be passed over (a ZIP
   * lets them be passed over unread). `totalBytes` holds only the files a paper keeps, so this
   * is twice it: room for 300 MB of kept files and as much again of left-out ones, but a gzip
   * bomb of zeros stops here, after at most this many bytes, long before memory does.
   */
  inflatedBytes: 600_000_000,
  pathLength: 255,
  /** Papers one person may start in an hour: by hand, from a template, or out of archives. */
  papersPerHour: 100,
};
export type Limits = typeof LIMITS;

export type Entry = { path: string; bytes: Uint8Array };
export type Skipped = { path: string; reason: string };

/**
 * Program source and data files that \lstinputlisting and the like read. Case does not matter
 * (the regexes are /i), so plot.R is kept.
 */
export const SOURCE =
  'py|c|h|cc|cpp|hpp|java|m|r|jl|js|ts|rs|go|rb|pl|sh|sql|hs|ml|scala|kt|swift|cs|f|f90|asm|s|v|vhd|json|ya?ml|xml|toml|ini|html|css';

/** What a LaTeX project is made of. Anything else in an archive is listed and left out. */
const WANTED = new RegExp(
  `\\.(tex|ltx|bib|bst|cls|sty|bbx|cbx|def|cfg|clo|tikz|pgf|pdf_tex|dat|lua|ist|inc|fd|ldf|ttf|otf|png|jpe?g|pdf|eps|csv|tsv|txt|md|${SOURCE})$`,
  'i',
);
/** Written into every export by PaperWeave; read back never, or the next export would hold it twice. */
const TOOLCHAIN = /(^|\/)paperweave-toolchain\.json$/;
const TOOLCHAIN_REASON = 'written by PaperWeave on download';
/** Pictures LaTeX is not able to read as they are. */
const PICTURE = /\.(svg|gif|tiff?|bmp)$/i;
const PICTURE_REASON = 'LaTeX cannot use this picture as it is: convert it to PDF or PNG';
const SYSTEM = /(^|\/)(__MACOSX|\.git|\.svn)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$/;
const BUILD =
  /\.(aux|log|out|toc|lof|lot|bbl|blg|fls|fdb_latexmk|synctex\.gz|synctex|nav|snm|vrb)$/i;
/**
 * A .bbl is build output, made again from the .bib files. An archive with no .bib file at all
 * (as arXiv gives them) has no other way to its bibliography, so there it is kept. When there is
 * a .bib, the .bbl is set aside and returned as `bbl`, so the import can keep the ones a paper
 * needs: it reads one by name, or names a .bib that is not in the archive.
 */
const BBL = /\.bbl$/i;
const BBL_REASON = 'build output, made again on compile';
const BIB = /\.bib$/i;

/** A gzip that holds one file and not a tar: a .tex.gz, say. Nothing in it says what the rest of the paper is. */
function notZip(): string {
  return 'This is a .gz, one compressed file. Unpack it and put it in a ZIP with the rest of the paper, then import that.';
}

/** `what` is how the refusal names the archive: "ZIP", or "archive" for a tar. */
const bad = (message: string, what = 'ZIP') =>
  new AppError('invalid_input', `This ${what} cannot be imported: ${message}.`);

const isGzip = (bytes: Uint8Array) => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
const hasUstar = (bytes: Uint8Array) =>
  bytes.length >= 262 && Buffer.from(bytes.subarray(257, 262)).toString('latin1') === 'ustar';

/** The most bytes a file system allows in one name of a path. Counted in UTF-8, not characters. */
const NAME_BYTES = 255;
const tooLong = (part: string) => Buffer.byteLength(part, 'utf8') > NAME_BYTES;

/**
 * The folder or file that `path` would share a name with, or '' if there is none: an existing
 * path that is a folder on the way to `path`, or that `path` is a folder on the way to. Neither
 * can be written to disk. `path` itself is not compared with an equal one: that is a different
 * problem, with its own message.
 */
export function pathClash(path: string, existing: Iterable<string>): string {
  for (const other of existing) {
    if (other.startsWith(`${path}/`)) return path;
    if (path.startsWith(`${other}/`)) return other;
  }
  return '';
}

/** The refusal for `pathClash`, worded for a name that is being added. */
export const clashMessage = (name: string) =>
  `A file and a folder cannot share the name "${name}".`;

/**
 * A name in Unicode NFC. macOS writes file names decomposed (NFD), authors type references
 * composed, and a file system takes the bytes as they are: so names are kept composed. Anything
 * that is not a string is returned as it is, for `checkPath` to refuse.
 */
export function nfc(path: unknown): unknown {
  return typeof path === 'string' ? path.normalize('NFC') : path;
}

/**
 * The name of a ZIP entry. A name without the UTF-8 flag is read by yauzl as CP437; one that is
 * in fact valid UTF-8 (as macOS writes them) is read as UTF-8 here, and one that is not keeps
 * the CP437 reading. Always in NFC, and without "./" or empty parts (see `tidy`).
 */
function entryName(entry: yauzl.Entry): string {
  return tidy(rawName(entry));
}

/**
 * Drop "./" segments and empty ones ("./main.tex", "sec//a.tex", "a/./b.tex"), as `tar -a -cf`
 * writes them. Only whole segments are removed, so nothing is added: ".." and a leading "/"
 * (which yauzl refuses before this runs) cannot appear. A name that ends in "/" or "/." is a
 * folder, and one with nothing left is the folder "./".
 */
function tidy(name: string): string {
  const out = name
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .join('/');
  const folder = name.endsWith('/') || name === '.' || name.endsWith('/.');
  return folder ? (out ? out + '/' : './') : out || './';
}

function rawName(entry: yauzl.Entry): string {
  const raw = entry.fileNameRaw;
  const plain =
    (entry.generalPurposeBitFlag & 0x800) !== 0 ||
    !raw.some((b) => b >= 0x80) ||
    entry.extraFields.some((f) => f.id === 0x7075);
  if (plain) return entry.fileName.normalize('NFC');
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(raw)
      .replace(/\\/g, '/')
      .normalize('NFC');
  } catch {
    return entry.fileName.normalize('NFC');
  }
}

/** Why a path cannot be a file in a paper, or '' if it can. */
export function checkPath(path: unknown, limits: Limits = LIMITS): string {
  if (typeof path !== 'string' || !path || path.length > limits.pathLength)
    return 'it is empty or too long';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return 'it has characters that cannot be used';
  if (
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return 'it must be a plain path inside the paper';
  if (path.split('/').some(tooLong))
    return `a name in it is over ${NAME_BYTES} bytes once written as UTF-8, which is the most a file system allows`;
  if (PICTURE.test(path)) return PICTURE_REASON;
  if (TOOLCHAIN.test(path))
    return 'paperweave-toolchain.json is written by PaperWeave on download, so it cannot be a file of the paper';
  // A .bbl is let in by name: it is how a paper with no .bib file keeps its bibliography.
  if (SYSTEM.test(path) || (!BBL.test(path) && (BUILD.test(path) || !WANTED.test(path))))
    return 'it is not a file type a paper uses';
  return '';
}

/**
 * Why a path cannot be named in LaTeX source, or null if it can. % # " { and } in any name of the
 * path break \includegraphics and \input in every engine, and cannot be quoted. Kept apart from
 * `checkPath` so that a paper which already has such a name can still be imported and restored.
 */
export function texName(path: string): string | null {
  return /[%#"{}]/.test(path)
    ? 'LaTeX cannot use a file name with % # " { or } in it. Choose another name.'
    : null;
}

export type Unpacked = { entries: Entry[]; skipped: Skipped[]; review: Entry[]; bbl: Entry[] };

/** What an archive does with each entry it is shown, the same whether it is a ZIP or a tar. */
type Verdict = 'ignore' | 'review' | 'file';

/**
 * The rules every archive format shares: which entries are left out and listed, which are kept,
 * and the limits on those that are kept. A reader finds the entries; this decides about them.
 */
class Intake {
  readonly skipped: Skipped[] = [];
  private readonly seen = new Set<string>();
  /** Entries left out by type, so that one listed twice shows once. */
  private readonly left = new Set<string>();
  private total = 0;
  private readonly limits: Limits;
  constructor(limits: Limits) {
    this.limits = limits;
  }

  /**
   * What to do with an entry by its name. A folder or a system path is `ignore`d: never read, so
   * neither counted nor checked, because .git and __MACOSX can be huge or odd. So is an entry of
   * a type the import leaves out, but that one is listed in `skipped`. The review data exported
   * with a paper is `review`: not a file of the paper, but read all the same.
   */
  sort(path: string): Verdict {
    if (path.endsWith('/')) return 'ignore';
    if (SYSTEM.test(path)) return 'ignore';
    const isReview = /(^|\/)paperweave-review\.json$/.test(path);
    const reason =
      isReview || BBL.test(path)
        ? ''
        : TOOLCHAIN.test(path)
          ? TOOLCHAIN_REASON
          : BUILD.test(path)
            ? BBL_REASON
            : /(^|\/)\.?latexmkrc$/.test(path)
              ? 'build script, never run'
              : PICTURE.test(path)
                ? PICTURE_REASON
                : !WANTED.test(path)
                  ? 'not a file type a paper uses'
                  : '';
    if (reason) {
      // Left out by type: never opened, so no size, link or encryption check applies. It is
      // only listed, and only if its name can be shown (no control characters, not too long).
      const showable =
        // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
        !/[\u0000-\u001f\u007f\\]/.test(path) && path.length <= this.limits.pathLength;
      if (showable && !this.left.has(path)) {
        this.left.add(path);
        this.skipped.push({ path, reason });
      }
      return 'ignore';
    }
    return isReview ? 'review' : 'file';
  }

  /**
   * For an entry that `sort` did not ignore, once its format's own checks (links, encryption)
   * have passed: a refusal of the whole archive, or 'skip' (listed, its name is too long for a
   * file system), or 'read'.
   */
  admit(path: string, size: number): { refuse: string } | 'skip' | 'read' {
    const { limits } = this;
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
    if (/[\u0000-\u001f\u007f\\]/.test(path) || path.length > limits.pathLength)
      return { refuse: 'a file name in it is not usable' };
    if (this.seen.has(path)) return { refuse: 'it contains the same file twice' };
    this.seen.add(path);
    if (this.seen.size > limits.files) return { refuse: 'it has too many files' };
    if (size > limits.fileBytes) return { refuse: `${path} is too large` };
    this.total += size;
    if (this.total > limits.totalBytes) return { refuse: 'it unpacks to too much data' };
    if (path.split('/').some(tooLong)) {
      this.skipped.push({ path, reason: `a name in it is over ${NAME_BYTES} bytes in UTF-8` });
      return 'skip';
    }
    return 'read';
  }

  /** The .bbl files wait for the end, where every entry is known, and so do folder clashes. */
  finish(entries: Entry[], review: Entry[]): Unpacked {
    const { skipped } = this;
    const bibs = entries.some((e) => BIB.test(e.path));
    const dropped = bibs ? entries.filter((e) => BBL.test(e.path)) : [];
    for (const e of dropped) skipped.push({ path: e.path, reason: BBL_REASON });
    // A file that is also a folder of other files cannot be written out: the folder wins.
    const names = new Set(entries.map((e) => e.path));
    const folders = new Set<string>();
    for (const n of names)
      for (let at = n.indexOf('/'); at >= 0; at = n.indexOf('/', at + 1))
        if (names.has(n.slice(0, at))) folders.add(n.slice(0, at));
    for (const f of folders)
      skipped.push({ path: f, reason: `${clashMessage(f)} The files in the folder were kept` });
    return {
      entries: entries.filter((e) => !dropped.includes(e) && !folders.has(e.path)),
      skipped,
      review,
      bbl: dropped.filter((e) => !folders.has(e.path)),
    };
  }
}

/**
 * Unpack an archive, or refuse it. What it is, is told by its first bytes and never by its name:
 * gzip (1f 8b) or a tar ("ustar" at 257) is read as a tar, anything else as a ZIP. Refusal is
 * all-or-nothing: a hostile archive imports nothing. Entries whose type the import leaves out are
 * never read, checked or counted (except toward `limits.entries`); every file that is read keeps
 * every check.
 */
export function readZip(zip: Uint8Array, limits: Limits = LIMITS): Promise<Unpacked> {
  const tar = isGzip(zip) || hasUstar(zip);
  if (zip.length > limits.archiveBytes) throw bad('it is too large', tar ? 'archive' : 'ZIP');
  return tar ? readTar(zip, limits) : readZipFile(zip, limits);
}

function readZipFile(zip: Uint8Array, limits: Limits): Promise<Unpacked> {
  return new Promise((resolve, reject) => {
    // yauzl refuses absolute paths and ".." itself, and checks each entry's real size against
    // the size the archive claims.
    yauzl.fromBuffer(Buffer.from(zip), { lazyEntries: true }, (err, file) => {
      if (err) return reject(bad('it is not a readable ZIP file'));
      const entries: Entry[] = [];
      // Review data exported with a paper: not a file of the paper, but read all the same.
      const review: Entry[] = [];
      const intake = new Intake(limits);
      const fail = (message: string) => {
        file.close();
        reject(bad(message));
      };
      if (file.entryCount > limits.entries) return fail('it has too many files');
      file.on('error', () => reject(bad('it is damaged or not what it claims to be')));
      file.on('end', () => resolve(intake.finish(entries, review)));
      file.on('entry', (entry: yauzl.Entry) => {
        const path = entryName(entry);
        const verdict = intake.sort(path);
        if (verdict === 'ignore') return file.readEntry();
        // The Unix file type lives in the top bits; 0o120000 is a symbolic link.
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
          return fail('it contains a symbolic link');
        if (entry.isEncrypted()) return fail('it is password-protected');
        const outcome = intake.admit(path, entry.uncompressedSize);
        if (typeof outcome === 'object') return fail(outcome.refuse);
        if (outcome === 'skip') return file.readEntry();
        const isReview = verdict === 'review';
        file.openReadStream(entry, (openErr, stream) => {
          if (openErr) return fail('it is damaged or not what it claims to be');
          const chunks: Buffer[] = [];
          let read = 0;
          stream.on('data', (chunk: Buffer) => {
            read += chunk.length;
            // Belt and braces: never hold more than the entry said it was.
            if (read > entry.uncompressedSize) stream.destroy(new Error('size'));
            else chunks.push(chunk);
          });
          stream.on('error', () => fail('it is damaged or not what it claims to be'));
          stream.on('end', () => {
            (isReview ? review : entries).push({ path, bytes: Buffer.concat(chunks) });
            file.readEntry();
          });
        });
      });
      file.readEntry();
    });
  });
}

// ---- tar

const BLOCK = 512;
/**
 * The most a GNU long name or a pax header may hold. A path of `pathLength` (255) characters is at
 * most 4 bytes each in UTF-8, about 1 KB, and a pax record adds a length and `path=`; the other
 * records a writer adds (mtime, uid, size) are short. 4 KB leaves room for those and no more, so
 * a header cannot be made into a megabyte of records for the reader to walk.
 */
const META_BYTES = 4096;
/** Headers read between turns of the event loop, so that a plain tar in one chunk cannot starve it. */
const YIELD_EVERY = 256;
const ABSOLUTE =
  'a file name in it is absolute or has .. in it, so it would not stay inside the paper';
const TRUNCATED = 'it is cut short: it ends before its last file does';
const DAMAGED = 'it is damaged or not what it claims to be';

/** A reason to refuse the whole archive, found while reading a tar. */
class Refusal extends Error {}

/**
 * The inflated bytes of a .tar.gz, as they come, with no more than `cap` of them ever let
 * through: a bomb stops at the cap, and memory never holds more than one chunk of it.
 */
async function* inflated(gz: Uint8Array, cap: number): AsyncGenerator<Buffer> {
  const gunzip = createGunzip({ chunkSize: 1 << 16 });
  gunzip.end(Buffer.from(gz));
  let seen = 0;
  try {
    for await (const chunk of gunzip) {
      seen += (chunk as Buffer).length;
      if (seen > cap) throw new Refusal('it unpacks to too much data');
      yield chunk as Buffer;
    }
  } catch (err) {
    // zlib's word for a stream that ends before its trailer.
    if ((err as { code?: string }).code === 'Z_BUF_ERROR') throw new Refusal(TRUNCATED);
    throw err;
  } finally {
    gunzip.destroy();
  }
}

/** Bytes pulled from a source of chunks: some kept, some passed over without being kept. */
class Reader {
  private queue: Buffer[] = [];
  private have = 0;
  private readonly it: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) {
    this.it = source[Symbol.asyncIterator]();
  }
  private async more(): Promise<boolean> {
    const r = await this.it.next();
    if (r.done) return false;
    this.queue.push(r.value);
    this.have += r.value.length;
    return true;
  }
  /** Up to `n` bytes, fewer only if the source ends first. Nothing is consumed. */
  async peek(n: number): Promise<Buffer> {
    while (this.have < n && (await this.more()));
    return Buffer.concat(this.queue).subarray(0, n);
  }
  /** Exactly `n` bytes, kept. */
  async take(n: number): Promise<Buffer> {
    while (this.have < n) if (!(await this.more())) throw new Refusal(TRUNCATED);
    return this.cut(n, true)!;
  }
  /** `n` bytes passed over: never gathered into one buffer. */
  async skip(n: number): Promise<void> {
    while (n > 0) {
      if (this.have === 0 && !(await this.more())) throw new Refusal(TRUNCATED);
      const k = Math.min(n, this.have);
      this.cut(k, false);
      n -= k;
    }
  }
  /** What is left, read to its end so that a damaged gzip trailer is found. */
  async drain(): Promise<void> {
    this.queue = [];
    this.have = 0;
    while (await this.more()) {
      this.queue = [];
      this.have = 0;
    }
  }
  async close(): Promise<void> {
    await this.it.return?.();
  }
  private cut(n: number, keep: boolean): Buffer | null {
    const out: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const head = this.queue[0];
      if (head.length <= need) {
        this.queue.shift();
        if (keep) out.push(head);
        need -= head.length;
      } else {
        if (keep) out.push(head.subarray(0, need));
        this.queue[0] = head.subarray(need);
        need = 0;
      }
    }
    this.have -= n;
    return keep ? Buffer.concat(out, n) : null;
  }
}

/** A tar header's checksum: the sum of its bytes, with the checksum field read as spaces. */
function checksumOk(head: Buffer, stored: number): boolean {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : head[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  // Some old writers summed signed bytes.
  return stored === unsigned || stored === signed;
}

const isZeroBlock = (head: Buffer) => head.every((b) => b === 0);

/** A header's octal number. A base-256 one (a high first bit: files over 8 GB) is refused. */
function octal(head: Buffer, at: number, length: number): number {
  if (head[at] & 0x80)
    throw new Refusal(
      'it stores a size in base-256, which is not read (repack it with tar --format=ustar)',
    );
  const text = head.toString('latin1', at, at + length).replace(/^[ \0]+|[ \0]+$/g, '');
  if (!/^[0-7]+$/.test(text)) throw new Refusal(DAMAGED);
  return parseInt(text, 8);
}

/** The text of a name field up to its first NUL. */
const field = (head: Buffer, at: number, length: number): Buffer => {
  const end = head.indexOf(0, at);
  return head.subarray(at, end >= 0 && end < at + length ? end : at + length);
};

/** The name of an entry, from its bytes: UTF-8 or refused, a plain path inside the archive or refused. */
function tarName(raw: Buffer): string {
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Refusal('a file name in it is not valid UTF-8');
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..'))
    throw new Refusal(ABSOLUTE);
  return tidy(name.normalize('NFC'));
}

/** What a pax extended header says that is read here: the path and the size. */
function paxFields(data: Buffer): { path?: Buffer; size?: number } {
  const out: { path?: Buffer; size?: number } = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const digits = space < 0 ? '' : data.toString('latin1', at, space);
    if (!/^[1-9]\d{0,6}$/.test(digits)) throw new Refusal(DAMAGED);
    const length = Number(digits);
    if (length <= space - at + 1 || at + length > data.length) throw new Refusal(DAMAGED);
    const record = data.subarray(space + 1, at + length - 1);
    if (data[at + length - 1] !== 0x0a) throw new Refusal(DAMAGED);
    const eq = record.indexOf(0x3d);
    if (eq < 0) throw new Refusal(DAMAGED);
    const key = record.toString('utf8', 0, eq);
    const value = record.subarray(eq + 1);
    if (key.startsWith('GNU.sparse')) throw new Refusal(SPARSE);
    if (key === 'path') {
      if (!value.length || value.includes(0))
        throw new Refusal('a file name in it is empty or has a NUL in it');
      out.path = Buffer.from(value);
    }
    if (key === 'size') {
      if (!/^\d{1,15}$/.test(value.toString('latin1'))) throw new Refusal(DAMAGED);
      out.size = Number(value.toString('latin1'));
    }
    at += length;
  }
  return out;
}
const SPARSE = 'it holds a sparse file, which is not read (repack it without --sparse)';

const REGULAR = new Set(['0', '\0', '7']);

/**
 * Unpack a tar, plain or gzipped, as `readZip` does a ZIP, with the same rules for what is kept.
 * Read as ustar, with GNU long names (type L) and pax paths (type x). Refused, each with its own
 * sentence: a header that is not ustar (old V7), sparse files, sizes in base-256, a bad
 * checksum, a cut-short archive, links and other special files named as files of a paper, a name
 * that is absolute, has .., or is not UTF-8, the same file twice, and anything over the limits.
 * What a paper does not keep is passed over without being held.
 */
export async function readTar(tar: Uint8Array, limits: Limits = LIMITS): Promise<Unpacked> {
  if (tar.length > limits.archiveBytes) throw bad('it is too large', 'archive');
  const gz = isGzip(tar);
  const reader = new Reader(
    gz
      ? inflated(tar, limits.inflatedBytes)
      : (async function* () {
          yield Buffer.from(tar);
        })(),
  );
  try {
    if (gz) {
      const head = await reader.peek(BLOCK);
      if (!hasUstar(head)) {
        // One compressed file, or a tar of the old kind that has no "ustar" in it.
        if (head.length === BLOCK && !isZeroBlock(head) && checksumOk(head, octalOr(head)))
          throw new Refusal(V7);
        throw new AppError('invalid_input', notZip());
      }
    }
    const entries: Entry[] = [];
    const review: Entry[] = [];
    const intake = new Intake(limits);
    let count = 0;
    // A long name or a pax header applies to the one entry after it.
    let longName: Buffer | undefined;
    let pax: { path?: Buffer; size?: number } = {};
    for (;;) {
      const head = await reader.take(BLOCK);
      if (isZeroBlock(head)) break;
      // Every header counts, metadata ones too, and the loop gives way now and then.
      if (++count > limits.entries) throw new Refusal('it has too many files');
      if (count % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
      if (!checksumOk(head, octal(head, 148, 8)))
        throw new Refusal('a header in it has a bad checksum');
      if (head.toString('latin1', 257, 262) !== 'ustar') throw new Refusal(V7);
      const type = String.fromCharCode(head[156]);
      let size = octal(head, 124, 12);
      const padded = (n: number) => Math.ceil(n / BLOCK) * BLOCK;
      if (type === 'S') throw new Refusal(SPARSE);
      if (type === 'L' || type === 'x' || type === 'g' || type === 'K') {
        // Headers about the entry after them, or about the whole archive (g, K: not read).
        if (size > META_BYTES) throw new Refusal('a header in it is too long');
        if (type === 'g' || type === 'K') {
          await reader.skip(padded(size));
          continue;
        }
        const data = (await reader.take(padded(size))).subarray(0, size);
        if (type === 'L') {
          const end = data.indexOf(0);
          longName = Buffer.from(end >= 0 ? data.subarray(0, end) : data);
        } else pax = paxFields(data);
        continue;
      }
      // POSIX ustar has a prefix field. GNU's "ustar  " has other things there.
      const posix = head.toString('latin1', 257, 263) === 'ustar\0';
      const prefix = posix ? field(head, 345, 155) : Buffer.alloc(0);
      const own = field(head, 0, 100);
      const rawName =
        pax.path ??
        longName ??
        (prefix.length ? Buffer.concat([prefix, Buffer.from('/'), own]) : Buffer.from(own));
      if (pax.size !== undefined) size = pax.size;
      pax = {};
      longName = undefined;

      let path = tarName(rawName);
      if (type === '5' && !path.endsWith('/')) path += '/';
      const verdict = intake.sort(path);
      // A link, or a link's name, has no data of its own.
      const link = type === '1' || type === '2';
      const data = link ? 0 : padded(size);
      if (verdict === 'ignore') {
        await reader.skip(data);
        continue;
      }
      if (link)
        throw new Refusal(type === '2' ? 'it contains a symbolic link' : 'it contains a hard link');
      if (!REGULAR.has(type)) throw new Refusal('it contains a file that is not a plain file');
      const outcome = intake.admit(path, size);
      if (typeof outcome === 'object') throw new Refusal(outcome.refuse);
      if (outcome === 'skip') {
        await reader.skip(data);
        continue;
      }
      const bytes = (await reader.take(data)).subarray(0, size);
      (verdict === 'review' ? review : entries).push({ path, bytes });
    }
    await reader.drain();
    return intake.finish(entries, review);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw bad(err instanceof Refusal ? err.message : DAMAGED, 'archive');
  } finally {
    await reader.close().catch(() => {});
  }
}
const V7 =
  'it is an old-style tar (no "ustar" in its headers), which is not read: repack it with tar --format=ustar';

/** The checksum a first header states, or -1 if it is not a number. */
function octalOr(head: Buffer): number {
  try {
    return octal(head, 148, 8);
  } catch {
    return -1;
  }
}

/** The archive as yazl writes it. A fixed date, so the same files always give the same archive. */
function zipOf(entries: Entry[]) {
  const zip = new yazl.ZipFile();
  for (const e of entries) zip.addBuffer(Buffer.from(e.bytes), e.path, { mtime: new Date(0) });
  zip.end();
  return zip.outputStream;
}

export function writeZip(entries: Entry[]): Promise<Uint8Array> {
  const out = zipOf(entries);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    out.on('error', reject);
    out.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * The same bytes as `writeZip`, as a stream: for a response, which on Vercel may be larger than
 * 4.5 MB only if it is streamed.
 */
export function zipStream(entries: Entry[] | AsyncIterable<Entry>): ReadableStream<Uint8Array> {
  if (Array.isArray(entries)) return Readable.toWeb(zipOf(entries)) as ReadableStream<Uint8Array>;
  // Entries that are still on their way are added as they arrive, in the order they come. If one
  // fails, the stream fails with it, and nothing more is asked for.
  const zip = new yazl.ZipFile();
  const out = zip.outputStream as unknown as Readable;
  (async () => {
    for await (const e of entries) {
      if (out.destroyed) return;
      zip.addBuffer(Buffer.from(e.bytes), e.path, { mtime: new Date(0) });
    }
    zip.end();
  })().catch((err) => out.destroy(err));
  return Readable.toWeb(out) as ReadableStream<Uint8Array>;
}
