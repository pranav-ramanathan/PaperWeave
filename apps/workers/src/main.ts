// The worker: builds and draws whatever is queued, then waits to be told there is more.
import { blobStore, connect, listen } from '@paperweave/server';
import { buildNext, imageId } from './builder.ts';
import { drawNext } from './charts.ts';

const pool = connect();
const store = blobStore();
const image = imageId();
let wake: () => void = () => {};
// Told at once when there is something to build or draw. If the connection that listens is
// lost it is made again; the timer below finds whatever was announced meanwhile.
await listen(process.env.DATABASE_URL, ['builds', 'charts'], () => wake());
console.log(`build worker ready, toolchain ${image.slice(0, 19)}`);

for (;;) {
  try {
    while ((await buildNext(pool, store, image)) || (await drawNext(pool, store, image)));
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
