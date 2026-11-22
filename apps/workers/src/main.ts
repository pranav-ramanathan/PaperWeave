// The worker: builds and draws whatever is queued, then waits to be told there is more.
import { blobStore, connect, forgetUploads, listen, UPLOAD_KEEP_MS } from '@paperweave/server';
import { buildNext, imageId } from './builder.ts';
import { drawNext } from './charts.ts';
import { takeTurns } from './turns.ts';

const pool = connect();
const store = blobStore();
const image = imageId();
let wake: () => void = () => {};
// Told at once when there is something to build or draw. If the connection that listens is
// lost it is made again; the timer below finds whatever was announced meanwhile.
await listen(process.env.DATABASE_URL, ['builds', 'charts'], () => wake());
console.log(`build worker ready, toolchain ${image.slice(0, 19)}`);

// Uploads that were put in the store and never taken (the person closed the page): removed
// when they are half an hour old. Checked every hour, and once at the start.
let swept = 0;
const next = takeTurns(
  () => buildNext(pool, store, image),
  () => drawNext(pool, store, image),
);
for (;;) {
  try {
    if (Date.now() - swept > 3600_000) {
      swept = Date.now();
      const n = await store.uploadSweep(UPLOAD_KEEP_MS);
      if (n) console.log(`removed ${n} old uploads`);
      await forgetUploads(pool);
    }
    while (await next());
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
