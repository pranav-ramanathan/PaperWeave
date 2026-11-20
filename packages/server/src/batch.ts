// Doing a list of slow things a few at a time. The database and the store may be a long way off,
// so a loop that waits for each one in turn spends nearly all its time waiting.

/** Store reads, which use no connection of the pool, go this many at a time. */
export const READS = 16;
/** Anything that takes a connection of the pool for each item goes this many at a time. */
export const CONNECTIONS = 8;

/** `fn` of each item, at most `limit` running at once. The results are in the order of the items. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    // After a failure nobody takes more; the others finish the one they have.
    while (next < items.length && !failed) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * `fn` of each item, handed out in the order of the items as each is done, with up to `limit`
 * started ahead of the one being waited for. Stopping early stops starting more.
 */
export async function* readAhead<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  const started: Promise<R>[] = [];
  let next = 0;
  const fill = (upTo: number) => {
    for (; next < items.length && next < upTo; next++) {
      const p = fn(items[next]);
      p.catch(() => {}); // seen when its turn comes, not before
      started.push(p);
    }
  };
  for (let i = 0; i < items.length; i++) {
    fill(i + limit);
    yield await started[i];
  }
}
