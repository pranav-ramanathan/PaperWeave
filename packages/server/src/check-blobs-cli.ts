// Check that the object store holds everything the database points at. Run after a restore:
// pnpm --filter @paperweave/server check-blobs
import { checkBlobs } from './backup.ts';
import { blobStore } from './blobs.ts';
import { connect } from './db.ts';

const pool = connect();
const found = await checkBlobs(pool, blobStore());
await pool.end();
console.log(
  `${found.referenced} stored objects referred to; ${found.missing.length} missing, ${found.corrupt.length} corrupt.`,
);
for (const digest of found.missing) console.log(`missing ${digest}`);
for (const digest of found.corrupt) console.log(`corrupt ${digest}`);
process.exit(found.missing.length + found.corrupt.length ? 1 : 0);
