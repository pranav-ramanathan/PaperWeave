// Reading and writing project ZIPs. An uploaded archive is untrusted: nothing in it is believed
// until checked, and nothing is written anywhere by its own say-so.
import yauzl from 'yauzl';
import yazl from 'yazl';
import { AppError } from './errors.ts';

export const LIMITS = {
  archiveBytes: 100_000_000,
  files: 2_000,
  fileBytes: 50_000_000,
  totalBytes: 300_000_000,
  pathLength: 255,
};
export type Limits = typeof LIMITS;

export type Entry = { path: string; bytes: Uint8Array };
export type Skipped = { path: string; reason: string };

/** What a LaTeX project is made of. Anything else in an archive is listed and left out. */
const WANTED = /\.(tex|ltx|bib|bst|cls|sty|bbx|cbx|def|cfg|clo|png|jpe?g|pdf|eps|csv|tsv|txt|md)$/i;
const SYSTEM = /(^|\/)(__MACOSX|\.git|\.svn)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$/;
const BUILD =
  /\.(aux|log|out|toc|lof|lot|bbl|blg|fls|fdb_latexmk|synctex\.gz|synctex|nav|snm|vrb)$/i;

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
      file.on('end', () => resolve({ entries, skipped, review }));
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
        const reason = isReview
          ? ''
          : BUILD.test(path)
            ? 'build output, made again on compile'
            : /(^|\/)\.?latexmkrc$/.test(path)
              ? 'build script, never run'
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
