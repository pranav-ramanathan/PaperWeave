import { expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  cleanPresence,
  MAX_PRESENCE_BYTES,
  MAX_PRESENCE_REMOVALS,
  presenceSize,
} from './presence.ts';

const clean = (states: Record<number, unknown>, removed: number[] = []) => {
  const map = new Map<number, unknown>(Object.entries(states).map(([k, v]) => [Number(k), v]));
  const gone = new Set(removed);
  const dropped = cleanPresence(map, gone);
  return { map, gone, dropped };
};

test('a state with 100,000 entries is reduced to one', () => {
  const states = new Map<number, unknown>();
  for (let i = 0; i < 100_000; i++) states.set(i, { user: { name: `p${i}` } });
  const removed = new Set<number>();
  const dropped = cleanPresence(states, removed);
  expect(states.size).toBe(1);
  expect(states.get(0)).toEqual({ user: { name: 'p0' } });
  expect(dropped).toBe(99_999);
});

test('a state too large to be presence is dropped, not cut', () => {
  const { map, dropped } = clean({ 7: { user: { name: 'x'.repeat(3_900_000) } } });
  expect(map.size).toBe(0);
  expect(dropped).toBe(1);
  // Just inside the limit it is kept, cut to a name's length.
  const room = MAX_PRESENCE_BYTES - JSON.stringify({ user: { name: '' } }).length;
  expect(clean({ 7: { user: { name: 'x'.repeat(room) } } }).map.size).toBe(1);
  expect(clean({ 7: { user: { name: 'x'.repeat(room + 1) } } }).map.size).toBe(0);
});

test('the next state is kept when the first is too large', () => {
  const { map } = clean({
    1: { user: { name: 'x'.repeat(10_000) } },
    2: { user: { name: 'Ada' } },
  });
  expect([...map.keys()]).toEqual([2]);
});

test('a name is cut to 80 characters', () => {
  const { map } = clean({ 1: { user: { name: 'n'.repeat(500) } } });
  expect((map.get(1) as { user: { name: string } }).user.name).toBe('n'.repeat(80));
});

test('a colour that is not a simple one is dropped, and a simple one is kept', () => {
  const bad = clean({
    1: { user: { name: 'Ada', color: 'url(http://x)', colorLight: 'red; background: x' } },
  });
  expect(bad.map.get(1)).toEqual({ user: { name: 'Ada' } });
  const good = clean({ 1: { user: { name: 'Ada', color: '#a1B2c3', colorLight: '#a1b2c333' } } });
  expect(good.map.get(1)).toEqual({
    user: { name: 'Ada', color: '#a1B2c3', colorLight: '#a1b2c333' },
  });
});

test('fields that are not known are stripped', () => {
  const { map } = clean({
    1: {
      user: { name: 'Ada', color: '#112233', avatar: 'x'.repeat(100), nested: { a: 1 } },
      cursor: null,
      extra: { big: [1, 2, 3] },
      status: 'typing',
    },
  });
  expect(map.get(1)).toEqual({ user: { name: 'Ada', color: '#112233' }, cursor: null });
});

test('both shapes of cursor survive intact', () => {
  const doc = new Y.Doc();
  const text = doc.getText('source');
  text.insert(0, 'Hello there');
  const at = (i: number) => Y.createRelativePositionFromTypeIndex(text, i);
  // yCollab sends the relative positions themselves; once through JSON they are what the server sees.
  const collab = JSON.parse(JSON.stringify({ anchor: at(2), head: at(5) }));
  expect(collab.anchor).toHaveProperty('type');
  // The visual view sends relativePositionToJSON, which leaves out what is not set.
  const visual = JSON.parse(
    JSON.stringify({
      anchor: Y.relativePositionToJSON(at(1)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, text.length)),
    }),
  );
  const { map } = clean({
    1: { user: { name: 'A' }, cursor: collab },
    2: { user: { name: 'B' }, cursor: visual },
  });
  expect(map.get(1)).toEqual({ user: { name: 'A' }, cursor: collab });
  // Only one state is kept: check the second on its own.
  expect(clean({ 2: { user: { name: 'B' }, cursor: visual } }).map.get(2)).toEqual({
    user: { name: 'B' },
    cursor: visual,
  });
  // And they still mean the same place in the text.
  const back = clean({ 2: { cursor: visual } }).map.get(2) as { cursor: typeof visual };
  expect(
    Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(back.cursor.anchor),
      doc,
    )?.index,
  ).toBe(1);
});

test('a cursor with a position that is not one is dropped, the rest kept', () => {
  const { map } = clean({
    1: {
      user: { name: 'A' },
      cursor: { anchor: { tname: 'x'.repeat(1000) }, head: { tname: 'source' } },
    },
  });
  expect(map.get(1)).toEqual({ user: { name: 'A' } });
});

test('at most 64 removals are kept', () => {
  const { gone } = clean(
    {},
    Array.from({ length: 5000 }, (_, i) => i),
  );
  expect(gone.size).toBe(MAX_PRESENCE_REMOVALS);
  expect(clean({}, [1, 2, 3]).gone.size).toBe(3);
});

/** A message as the library frames it: the file's name, the type, and a length-prefixed body. */
const varUint = (n: number) => {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const frame = (type: number, body: Uint8Array, name = 'file-1') => {
  const bytes = new TextEncoder().encode(name);
  return Uint8Array.from([
    ...varUint(bytes.length),
    ...bytes,
    ...varUint(type),
    ...varUint(body.length),
    ...body,
  ]);
};

test('presenceSize is the body of an awareness message, and null for anything else', () => {
  expect(presenceSize(frame(1, new Uint8Array(10)))).toBe(10);
  expect(presenceSize(frame(1, new Uint8Array(0)))).toBe(0);
  expect(presenceSize(frame(1, new Uint8Array(3_000_000)))).toBe(3_000_000);
  // A name that carries a session, and a body whose length takes two bytes.
  expect(presenceSize(frame(1, new Uint8Array(200), 'file-1\0session'))).toBe(200);
  // Sync (0), stateless (5) and query awareness (3) are not presence.
  expect(presenceSize(frame(0, new Uint8Array(10)))).toBeNull();
  expect(presenceSize(frame(5, new Uint8Array(10)))).toBeNull();
  expect(presenceSize(frame(3, new Uint8Array(0)))).toBeNull();
  // Not a message.
  expect(presenceSize(new Uint8Array(0))).toBeNull();
  expect(presenceSize(Uint8Array.from([200]))).toBeNull();
  // A body that claims more than there is.
  expect(presenceSize(frame(1, new Uint8Array(10)).subarray(0, 12))).toBeNull();
});
