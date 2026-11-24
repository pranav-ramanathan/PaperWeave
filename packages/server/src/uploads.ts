// Uploads that do not pass through the web app. A function on Vercel takes no more than 4.5 MB in
// a request (docs/deploy.md), so the browser puts a ZIP or a file straight into the store, under a
// temporary key, and then tells the app which key to take. Everything that was checked on an
// upload is checked here all the same: the browser's word for what it sent is never taken.
import type pg from 'pg';
import { type Limits, LIMITS } from './archive.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { createFile, replaceFile } from './files.ts';
import { importZip } from './import.ts';
import type { RewriteOpts } from './limits.ts';
import { id } from './projects.ts';

/** An upload nobody took is removed after this long: its address's ten minutes, then a margin. */
export const UPLOAD_KEEP_MS = 30 * 60 * 1000;
/** How many addresses one person may hold at once (ten minutes each), and bytes in an hour. */
export const UPLOADS_OUTSTANDING = 10;
export const UPLOAD_BYTES_PER_HOUR = 2 * 1024 ** 3;
const envCount = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const ZIP_TOO_LARGE = 'This ZIP cannot be imported: it is too large.';
const FILE_TOO_LARGE = 'That file is too large.';

/**
 * Where the browser may put a ZIP (`zip`, to import) or a file for a paper (`file`). A file is
 * only for someone who may write to that paper. The size is required, and one over the limit is
 * refused here, before anything is sent; the address takes a body of exactly that size. One
 * person may hold only so many addresses not yet taken, and ask for only so many bytes in an
 * hour. Two requests at the very same moment may pass the count together, by a few.
 */
export async function startUpload(
  db: Db,
  store: BlobStore,
  userId: string,
  what: { kind: 'zip' } | { kind: 'file'; projectId: string },
  size: unknown,
  limits: Limits = LIMITS,
  quota = {
    outstanding: envCount('UPLOADS_OUTSTANDING_PER_USER', UPLOADS_OUTSTANDING),
    bytesPerHour: envCount('UPLOAD_BYTES_PER_USER_HOUR', UPLOAD_BYTES_PER_HOUR),
  },
): Promise<{ key: string; url: string }> {
  if (what.kind === 'file') await authorize(db, userId, id(what.projectId), 'file.write');
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1)
    throw new AppError('invalid_input', 'The size of the upload is not a size.');
  const max = what.kind === 'zip' ? limits.archiveBytes : limits.fileBytes;
  if (size > max)
    throw new AppError('invalid_input', what.kind === 'zip' ? ZIP_TOO_LARGE : FILE_TOO_LARGE);
  const { rows } = await db.query(
    `select
       count(*) filter (where taken_at is null and created_at > now() - interval '10 minutes')::int as waiting,
       coalesce(sum(size), 0)::float8 as bytes
     from upload_addresses where user_id = $1 and created_at > now() - interval '1 hour'`,
    [userId],
  );
  if (rows[0].waiting >= quota.outstanding)
    throw new AppError('conflict', 'Too many uploads are waiting. Try again in a few minutes.');
  if (rows[0].bytes + size > quota.bytesPerHour)
    throw new AppError(
      'conflict',
      'That is more than can be uploaded in an hour. Try again later.',
    );
  const made = await store.uploadUrl(userId, size);
  await db.query('insert into upload_addresses (user_id, key, size) values ($1, $2, $3)', [
    userId,
    made.key,
    size,
  ]);
  return made;
}

/** Forget the record of addresses a day old, whose objects the sweep has long removed. */
export async function forgetUploads(db: Db): Promise<void> {
  await db.query(`delete from upload_addresses where created_at < now() - interval '1 day'`);
}

/**
 * The bytes of an upload, given to `use`, and the upload removed afterwards whatever `use` did.
 * Its size is asked of the store first: one over `max` is removed unread.
 */
async function takeUpload<T>(
  db: Db,
  store: BlobStore,
  userId: string,
  key: string,
  max: number,
  tooLarge: string,
  use: (bytes: Uint8Array) => Promise<T>,
): Promise<T> {
  // An upload is its maker's: someone else's key is not found, and nothing is read or removed.
  if (
    typeof key !== 'string' ||
    !/^tmp\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key) ||
    !key.startsWith(`tmp/${userId}/`)
  )
    throw new AppError('not_found', 'That upload was not found.');
  // An address is taken once: a second take of a key, or of one this site never made, finds
  // nothing. (A second PUT to the address before the take replaces the object, to the size it
  // was signed for; it cannot add bytes.)
  const claimed = await db.query(
    'update upload_addresses set taken_at = now() where key = $1 and user_id = $2 and taken_at is null',
    [key, userId],
  );
  if (claimed.rowCount === 0) throw new AppError('not_found', 'That upload was not found.');
  try {
    const size = await store.uploadSize(key);
    if (size === null)
      throw new AppError('invalid_input', 'That upload did not arrive. Try again.');
    if (size > max) throw new AppError('invalid_input', tooLarge);
    return await use(await store.uploadRead(key));
  } finally {
    await store.uploadDrop(key).catch(() => {});
  }
}

/** Import the ZIP that was uploaded under `key`, as `importZip` does one that was posted. */
export function importUploaded(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  key: string,
  fallbackName: string,
  limits: Limits = LIMITS,
) {
  return takeUpload(pool, store, userId, key, limits.archiveBytes, ZIP_TOO_LARGE, (zip) =>
    importZip(pool, store, userId, zip, fallbackName, limits),
  );
}

/** Add the file that was uploaded under `key` to a paper, as `createFile` does one that was posted. */
export async function addUploaded(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  key: string,
  path: unknown,
  limits: Limits = LIMITS,
  replace = false,
  budget: RewriteOpts = {},
): Promise<string> {
  // Before anything is read, and before the upload is touched: someone with no right to the
  // paper removes nothing.
  await authorize(db, userId, id(projectId), 'file.write');
  return takeUpload(db, store, userId, key, limits.fileBytes, FILE_TOO_LARGE, (bytes) =>
    replace
      ? replaceFile(db as pg.Pool, store, userId, projectId, path, bytes, limits, budget)
      : createFile(db, store, userId, projectId, path, bytes, limits),
  );
}
