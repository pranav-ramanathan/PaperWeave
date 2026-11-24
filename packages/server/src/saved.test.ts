import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { localChanges } from '../../bridge/src/saved.ts';
import { holds, TEXT } from './sync.ts';

test('the server is asked about exactly the inserts and deletes made here', () => {
  const server = new Y.Doc();
  server.getText(TEXT).insert(0, 'Hello world.\n');
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  const text = client.getText(TEXT);
  const changes = localChanges(client);
  const held = () => holds(server, Buffer.from(changes.question().saved, 'base64url'));
  const send = () =>
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client, Y.encodeStateVector(server)));

  // Nothing done here yet.
  expect(held()).toBe(true);

  text.insert(0, 'Oh. ');
  expect(held()).toBe(false);
  send();
  expect(held()).toBe(true);
  expect(changes.confirmed(changes.question().n)).toBe(true);

  // A delete adds nothing, so counting inserts would call it saved. It is not.
  const inserts = Y.encodeStateVector(client);
  text.delete(4, 6);
  expect(Y.encodeStateVector(client)).toEqual(inserts);
  expect(held()).toBe(false);
  send();
  expect(held()).toBe(true);
  expect(server.getText(TEXT).toString()).toBe('Oh. world.\n');

  // What arrives from other people is not this copy's to ask about.
  const asked = changes.question();
  server.getText(TEXT).insert(0, 'Someone else. ');
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server, Y.encodeStateVector(client)), 'remote');
  expect(changes.question().n).toBe(asked.n);
  expect(held()).toBe(true);

  // A yes to an earlier question does not cover what was typed after it.
  text.insert(0, 'Later. ');
  expect(changes.confirmed(asked.n)).toBe(false);
  expect(held()).toBe(false);

  // Deleting part of what someone else wrote, and part of one's own unsent text.
  text.delete(0, 12);
  expect(held()).toBe(false);
  send();
  expect(held()).toBe(true);
  expect(changes.confirmed(changes.question().n)).toBe(true);
  expect(server.getText(TEXT).toString()).toBe(text.toString());
});

type Range = { clock: number; len: number };

/** A document whose one author wrote `n` characters and then deleted the given runs. */
function docWithDeletes(client: number, n: number, runs: [number, number][]): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = client;
  const text = doc.getText(TEXT);
  text.insert(0, 'x'.repeat(n));
  doc.transact(() => {
    // From the end, so earlier positions stay where they were.
    for (const [start, len] of [...runs].sort((a, b) => b[0] - a[0])) text.delete(start, len);
  });
  return doc;
}

/** A snapshot that counts everything the document has and lists exactly these delete ranges. */
function snapshotOf(doc: Y.Doc, ranges: Map<number, Range[]>): Uint8Array {
  const ds = Y.createDeleteSet();
  for (const [client, list] of ranges) ds.clients.set(client, list as never);
  return Y.encodeSnapshot(Y.createSnapshot(ds, Y.decodeStateVector(Y.encodeStateVector(doc))));
}

const ask = (doc: Y.Doc, client: number, ...wanted: Range[]) =>
  holds(doc, snapshotOf(doc, new Map([[client, wanted]])));

// What `holds` did before it searched: a scan of every held range for every wanted one.
function holdsByScan(doc: Y.Doc, snapshot: Uint8Array): boolean {
  const want = Y.decodeSnapshot(snapshot);
  for (const [client, clock] of want.sv) if (Y.getState(doc.store, client) < clock) return false;
  const have = Y.createDeleteSetFromStructStore(doc.store);
  for (const [client, ranges] of want.ds.clients)
    for (const w of ranges)
      if (
        !(have.clients.get(client) ?? []).some(
          (h) => h.clock <= w.clock && w.clock + w.len <= h.clock + h.len,
        )
      )
        return false;
  return true;
}

test('a snapshot that repeats one delete range many times is answered quickly', () => {
  const HELD = 20_000;
  const runs: [number, number][] = [];
  for (let i = 0; i < HELD; i++) runs.push([2 * i, 1]);
  const doc = docWithDeletes(7, 2 * HELD + 1, runs);
  const last = { clock: 2 * (HELD - 1), len: 1 };
  const snapshot = snapshotOf(doc, new Map([[7, Array.from({ length: 100_000 }, () => last)]]));

  const started = performance.now();
  const answer = holds(doc, snapshot);
  const took = performance.now() - started;
  expect(answer).toBe(true);
  expect(took, `took ${Math.round(took)} ms`).toBeLessThan(2000);
});

test('a wanted range inside the first, a middle and the last held range is held', () => {
  const doc = docWithDeletes(7, 100, [
    [10, 5],
    [30, 8],
    [50, 4],
    [70, 6],
    [90, 10],
  ]);
  expect(ask(doc, 7, { clock: 10, len: 5 })).toBe(true);
  expect(ask(doc, 7, { clock: 11, len: 2 })).toBe(true);
  expect(ask(doc, 7, { clock: 50, len: 4 })).toBe(true);
  expect(ask(doc, 7, { clock: 51, len: 1 })).toBe(true);
  expect(ask(doc, 7, { clock: 92, len: 8 })).toBe(true);
  expect(ask(doc, 7, { clock: 99, len: 1 })).toBe(true);
});

test('a wanted range that starts inside a held range and runs past its end is not held', () => {
  const doc = docWithDeletes(7, 100, [
    [10, 5],
    [30, 8],
  ]);
  expect(ask(doc, 7, { clock: 12, len: 4 })).toBe(false);
  expect(ask(doc, 7, { clock: 37, len: 2 })).toBe(false);
  expect(ask(doc, 7, { clock: 30, len: 9 })).toBe(false);
});

test('a wanted range spanning two held ranges with a live character between is not held', () => {
  const doc = docWithDeletes(7, 40, [
    [10, 5],
    [16, 5],
  ]);
  // Character 15 is still there.
  expect(ask(doc, 7, { clock: 10, len: 11 })).toBe(false);
  expect(ask(doc, 7, { clock: 14, len: 3 })).toBe(false);
  expect(ask(doc, 7, { clock: 10, len: 5 }, { clock: 16, len: 5 })).toBe(true);
});

test('a wanted range before the first held range, or by an author with no deletes, is not held', () => {
  const doc = docWithDeletes(7, 40, [[10, 5]]);
  expect(ask(doc, 7, { clock: 2, len: 3 })).toBe(false);
  expect(ask(doc, 7, { clock: 9, len: 2 })).toBe(false);
  expect(ask(doc, 7, { clock: 0, len: 1 })).toBe(false);
  expect(ask(doc, 8, { clock: 10, len: 5 })).toBe(false);
  expect(ask(doc, 7)).toBe(true);
});

test('wanted ranges that are unsorted or repeated give the same answer as sorted ones', () => {
  const doc = docWithDeletes(7, 100, [
    [10, 5],
    [30, 8],
    [50, 4],
  ]);
  const a = { clock: 10, len: 5 };
  const b = { clock: 31, len: 3 };
  const c = { clock: 50, len: 4 };
  const bad = { clock: 48, len: 4 };
  expect(ask(doc, 7, a, b, c)).toBe(true);
  expect(ask(doc, 7, c, a, b)).toBe(true);
  expect(ask(doc, 7, b, b, c, a, a, c)).toBe(true);
  expect(ask(doc, 7, a, b, c, bad)).toBe(false);
  expect(ask(doc, 7, bad, c, b, a)).toBe(false);
  expect(ask(doc, 7, c, bad, bad, a, b, bad)).toBe(false);
});

test('random documents and snapshots agree with the scan the answer used to be', () => {
  let held = 0;
  let notHeld = 0;
  for (let seed = 1; seed <= 60; seed++) {
    let s = seed;
    const rand = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return Math.floor((s / 2 ** 32) * n);
    };
    // Two authors, interleaved, then a random scatter of deletes by each.
    const a = new Y.Doc();
    a.clientID = 100 + seed;
    const b = new Y.Doc();
    b.clientID = 5000 + seed;
    a.getText(TEXT).insert(0, 'a'.repeat(20 + rand(60)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getText(TEXT).insert(rand(10), 'b'.repeat(20 + rand(60)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    for (const d of [a, b]) {
      const t = d.getText(TEXT);
      for (let i = 0, n = rand(12); i < n && t.length > 0; i++) {
        const at = rand(t.length);
        t.delete(at, Math.min(1 + rand(5), t.length - at));
      }
      Y.applyUpdate(a === d ? b : a, Y.encodeStateAsUpdate(d));
    }
    const server = a;
    const have = Y.createDeleteSetFromStructStore(server.store);
    for (let round = 0; round < 40; round++) {
      const ranges = new Map<number, Range[]>();
      for (const client of [a.clientID, b.clientID, 1]) {
        const list: Range[] = [];
        const real = have.clients.get(client) ?? [];
        for (let i = 0, n = rand(5); i < n; i++) {
          const h = real[rand(real.length || 1)];
          const mode = rand(3);
          if (h && mode === 0) list.push({ clock: h.clock + rand(h.len), len: 1 });
          else if (h && mode === 1) list.push({ clock: h.clock, len: h.len + rand(3) });
          else list.push({ clock: rand(90), len: rand(8) });
        }
        if (list.length) ranges.set(client, list);
      }
      const snapshot = snapshotOf(server, ranges);
      const want = holdsByScan(server, snapshot);
      const got = holds(server, snapshot);
      expect(got, `seed ${seed}, round ${round}`).toBe(want);
      if (want) held++;
      else notHeld++;
    }
  }
  // The comparison would mean little if every answer were the same.
  expect(held).toBeGreaterThan(50);
  expect(notHeld).toBeGreaterThan(50);
});
