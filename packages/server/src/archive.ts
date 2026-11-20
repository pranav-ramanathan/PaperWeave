// Reading and writing project ZIPs. An uploaded archive is untrusted: nothing in it is believed
// until checked, and nothing is written anywhere by its own say-so.
import { constants, gunzipSync } from 'node:zlib';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { AppError } from './errors.ts';

export const LIMITS = {
  archiveBytes: 100_000_000,
  files: 2_000,
  fileBytes: 50_000_000,
  totalBytes: 300_000_000,
  pathLength: 255,
  /** Papers one person may start in an hour: by hand, from a template, or out of archives. */
  papersPerHour: 100,
};
export type Limits = typeof LIMITS;

export type Entry = { path: string; bytes: Uint8Array };
export type Skipped = { path: string; reason: string };

/** What a LaTeX project is made of. Anything else in an archive is listed and left out. */
const WANTED =
  /\.(tex|ltx|bib|bst|cls|sty|bbx|cbx|def|cfg|clo|tikz|pgf|pdf_tex|dat|lua|ist|inc|fd|ldf|ttf|otf|png|jpe?g|pdf|eps|csv|tsv|txt|md)$/i;
/** Pictures LaTeX is not able to read as they are. */
const PICTURE = /\.(svg|gif|tiff?|bmp)$/i;
const PICTURE_REASON = 'LaTeX cannot use this picture as it is: convert it to PDF or PNG';
const SYSTEM = /(^|\/)(__MACOSX|\.git|\.svn)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$/;
const BUILD =
  /\.(aux|log|out|toc|lof|lot|bbl|blg|fls|fdb_latexmk|synctex\.gz|synctex|nav|snm|vrb)$/i;
/**
 * A .bbl is build output, made again from the .bib files. An archive with no .bib file at all
 * (as arXiv gives them) has no other way to its bibliography, so there it is kept.
 */
const BBL = /\.bbl$/i;
const BBL_REASON = 'build output, made again on compile';
const BIB = /\.bib$/i;

/** What an archive that is not a ZIP is, by its first bytes, or '' if it may be one. */
function notZip(zip: Uint8Array): string {
  if (zip.length > 262 && Buffer.from(zip.subarray(257, 262)).toString('latin1') === 'ustar')
    return 'This is a .tar, not a ZIP. Unpack it and make a ZIP of the folder, then import that.';
  if (zip.length > 2 && zip[0] === 0x1f && zip[1] === 0x8b) {
    // A .tar.gz holds a tar once unzipped. Only the start of it is looked at.
    try {
      const head = gunzipSync(zip.subarray(0, 8192), {
        finishFlush: constants.Z_SYNC_FLUSH,
        maxOutputLength: 8 << 20,
      });
      if (head.length < 262 || head.subarray(257, 262).toString('latin1') !== 'ustar')
        return 'This is a .gz, one compressed file. Unpack it and put it in a ZIP with the rest of the paper, then import that.';
    } catch {
      // Not readable far enough to tell: arXiv's own shape is the likelier.
    }
    return 'This is a .tar.gz, as arXiv gives. Unpack it and make a ZIP of the folder, then import that.';
  }
  return '';
}

const bad = (message: string) =>
  new AppError('invalid_input', `This ZIP cannot be imported: ${message}.`);

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
  if (PICTURE.test(path)) return PICTURE_REASON;
  if (SYSTEM.test(path) || BUILD.test(path) || !WANTED.test(path))
    return 'it is not a file type a paper uses';
  return '';
}

/** Unpack an archive, or refuse it. Refusal is all-or-nothing: a hostile archive imports nothing. */
export function readZip(
  zip: Uint8Array,
  limits: Limits = LIMITS,
): Promise<{ entries: Entry[]; skipped: Skipped[]; review: Entry[] }> {
  if (zip.length > limits.archiveBytes) throw bad('it is too large');
  const other = notZip(zip);
  if (other) throw new AppError('invalid_input', other);
  return new Promise((resolve, reject) => {
    // yauzl refuses absolute paths and ".." itself, and checks each entry's real size against
    // the size the archive claims.
    yauzl.fromBuffer(Buffer.from(zip), { lazyEntries: true }, (err, file) => {
      if (err) return reject(bad('it is not a readable ZIP file'));
      const entries: Entry[] = [];
      const skipped: Skipped[] = [];
      // Review data exported with a paper: not a file of the paper, but read all the same.
      const review: Entry[] = [];
      const seen = new Set<string>();
      let total = 0;
      const fail = (message: string) => {
        file.close();
        reject(bad(message));
      };
      file.on('error', () => reject(bad('it is damaged or not what it claims to be')));
      file.on('end', () => {
        // The .bbl files wait here, where every entry is known.
        const bibs = entries.some((e) => BIB.test(e.path));
        const dropped = bibs ? entries.filter((e) => BBL.test(e.path)) : [];
        for (const e of dropped) skipped.push({ path: e.path, reason: BBL_REASON });
        resolve({ entries: entries.filter((e) => !dropped.includes(e)), skipped, review });
      });
      file.on('entry', (entry: yauzl.Entry) => {
        const path = entry.fileName;
        if (path.endsWith('/')) return file.readEntry();
        // The Unix file type lives in the top bits; 0o120000 is a symbolic link.
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
          return fail('it contains a symbolic link');
        if (entry.isEncrypted()) return fail('it is password-protected');
        // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
        if (/[\u0000-\u001f\u007f\\]/.test(path) || path.length > limits.pathLength)
          return fail('a file name in it is not usable');
        if (seen.has(path)) return fail('it contains the same file twice');
        seen.add(path);
        if (seen.size > limits.files) return fail('it has too many files');
        if (entry.uncompressedSize > limits.fileBytes) return fail(`${path} is too large`);
        total += entry.uncompressedSize;
        if (total > limits.totalBytes) return fail('it unpacks to too much data');

        if (SYSTEM.test(path)) return file.readEntry();
        const isReview = /(^|\/)paperweave-review\.json$/.test(path);
        const reason =
          isReview || BBL.test(path)
            ? ''
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
          skipped.push({ path, reason });
          return file.readEntry();
        }
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

export function writeZip(entries: Entry[]): Promise<Uint8Array> {
  const zip = new yazl.ZipFile();
  // A fixed date, so the same files always give the same archive.
  for (const e of entries) zip.addBuffer(Buffer.from(e.bytes), e.path, { mtime: new Date(0) });
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
