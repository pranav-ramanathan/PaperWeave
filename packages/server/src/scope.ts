// Work shared inside one request. A page asks for the same few things many times over, each
// function checking for itself that the person may see the paper and reading the paper's files
// again. Inside `withScope`, the first ask is answered from the database and the rest from it.
// The scope ends with the function it was given: nothing is kept between requests.
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { Db } from './db.ts';

const scopes = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/**
 * Run `fn` with an empty memory of what has been read. Only for work that writes nothing: what
 * is read once is not read again, so a write in the scope would not be seen by it.
 */
export const withScope = <T>(fn: () => Promise<T>): Promise<T> => scopes.run(new Map(), fn);

/**
 * `make()`, or, in a scope, the answer it already gave for `key`. Never for a transaction's
 * client (which sees its own writes and holds locks), only for the pool. A failed answer is not
 * kept.
 */
export function remembered<T>(db: Db, key: unknown[], make: () => Promise<T>): Promise<T> {
  const memory = scopes.getStore();
  if (!memory || !(db instanceof pg.Pool)) return make();
  const k = JSON.stringify(key);
  const have = memory.get(k);
  if (have) return have as Promise<T>;
  const made = make();
  memory.set(k, made);
  made.catch(() => {
    if (memory.get(k) === made) memory.delete(k);
  });
  return made;
}

/** `fn` in the scope it is already in, or in a new one if it is in none. */
export const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
  scopes.getStore() ? fn() : withScope(fn);
