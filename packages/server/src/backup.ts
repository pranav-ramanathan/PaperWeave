// After a restore: is everything the database points at really in the object store? The
// database and the store are backed up separately, so a restore can bring back one from a
// different moment than the other. This says what, if anything, is then missing.
import type { BlobStore } from './blobs.ts';
import type { Db } from './db.ts';

export type BlobCheck = {
  /** How many different stored objects the database refers to. */
  referenced: number;
  /** Those that are not in the store, and those whose bytes are not what their name says. */
  missing: string[];
  corrupt: string[];
};

/** Fetch every object the database refers to and check it against its digest. */
export async function checkBlobs(db: Db, store: BlobStore): Promise<BlobCheck> {
  const { rows } = await db.query(
    `select digest from all_files
     union select digest from revision_files
     union select pdf_digest from builds where pdf_digest is not null
     union select synctex_digest from builds where synctex_digest is not null
     union select bbl_digest from builds where bbl_digest is not null
     union select log_digest from builds where log_digest is not null
     union select pdf_digest from chart_draws
     union select png_digest from chart_draws`,
  );
  const out: BlobCheck = { referenced: rows.length, missing: [], corrupt: [] };
  for (const { digest } of rows) {
    // The store checks what it returns against the digest it was asked for, and throws.
    const found = await store.get(digest).catch(() => 'corrupt' as const);
    if (found === 'corrupt') out.corrupt.push(digest);
    else if (!found) out.missing.push(digest);
  }
  return out;
}
