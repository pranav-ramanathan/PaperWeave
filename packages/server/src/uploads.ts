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
import { createFile } from './files.ts';
import { importZip } from './import.ts';
import { id } from './projects.ts';

/** An upload nobody took is removed after this long. */
export const UPLOAD_KEEP_MS = 24 * 3600 * 1000;

const ZIP_TOO_LARGE = 'This ZIP cannot be imported: it is too large.';
const FILE_TOO_LARGE = 'That file is too large.';

/**
 * Where the browser may put a ZIP (`zip`, to import) or a file for a paper (`file`). A file is
 * only for someone who may write to that paper. A size over the limit is refused here, before
 * anything is sent; the address, if a size is given, takes a body of exactly that size.
 */
export async function startUpload(
  db: Db,
  store: BlobStore,
  userId: string,
  what: { kind: 'zip' } | { kind: 'file'; projectId: string },
  size?: number,
  limits: Limits = LIMITS,
): Promise<{ key: string; url: string }> {
  if (what.kind === 'file') await authorize(db, userId, id(what.projectId), 'file.write');
  if (size !== undefined && (!Number.isInteger(size) || size < 0))
    throw new AppError('invalid_input', 'The size of the upload is not a size.');
  const max = what.kind === 'zip' ? limits.archiveBytes : limits.fileBytes;
  if (size !== undefined && size > max)
    throw new AppError('invalid_input', what.kind === 'zip' ? ZIP_TOO_LARGE : FILE_TOO_LARGE);
  return store.uploadUrl(userId, size);
}

/**
 * The bytes of an upload, given to `use`, and the upload removed afterwards whatever `use` did.
 * Its size is asked of the store first: one over `max` is removed unread.
 */
async function takeUpload<T>(
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
  return takeUpload(store, userId, key, limits.archiveBytes, ZIP_TOO_LARGE, (zip) =>
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
): Promise<string> {
  // Before anything is read, and before the upload is touched: someone with no right to the
  // paper removes nothing.
  await authorize(db, userId, id(projectId), 'file.write');
  return takeUpload(store, userId, key, limits.fileBytes, FILE_TOO_LARGE, (bytes) =>
    createFile(db, store, userId, projectId, path, bytes, limits),
  );
}
