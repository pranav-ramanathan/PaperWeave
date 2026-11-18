// The worker: builds and draws whatever is queued, then waits to be told there is more.
import { blobStore, connect } from '@paperweave/server';
import pg from 'pg';
import { buildNext, imageId } from './builder.ts';
import { drawNext } from './charts.ts';

const pool = connect();
const store = blobStore();
const image = imageId();
const listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
await listener.connect();
await listener.query('listen builds');
await listener.query('listen charts');
let wake: () => void = () => {};
listener.on('notification', () => wake());
console.log(`build worker ready, toolchain ${image.slice(0, 19)}`);

for (;;) {
  try {
    while ((await buildNext(pool, store, image)) || (await drawNext(pool, store)));
  } catch (err) {
    console.error('worker error:', (err as Error).message);
  }
  // A notification wakes the worker at once; the timer catches one that was missed.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}
