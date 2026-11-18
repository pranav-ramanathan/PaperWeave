import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { watchSaved } from './saved.ts';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

/** A document being watched, the questions it has sent, and what it last said. */
function watched(ready = () => true) {
  const doc = new Y.Doc();
  const sent: { n: number; saved: string }[] = [];
  const said: boolean[] = [];
  const saving = watchSaved(doc, {
    send: (q) => void sent.push(JSON.parse(q)),
    ready,
    say: (unsaved) => void said.push(unsaved),
  });
  return { doc, text: doc.getText('source'), sent, said, saving };
}

test('it asks once typing pauses, and a yes to that question settles it', () => {
  const w = watched();
  w.text.insert(0, 'a');
  vi.advanceTimersByTime(200);
  w.text.insert(1, 'b');
  expect(w.said).toEqual([true, true]);
  vi.advanceTimersByTime(299);
  expect(w.sent).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(w.sent.map((q) => q.n)).toEqual([2]);
  w.saving.answered({ n: 2, saved: true });
  expect(w.saving.unsaved).toBe(false);
  expect(w.said.at(-1)).toBe(false);
  // And then it stops asking.
  vi.advanceTimersByTime(60_000);
  expect(w.sent).toHaveLength(1);
});

test('a question that is never answered is asked again, less and less often', () => {
  const w = watched();
  w.text.insert(0, 'a');
  // At 0.3 s, then 1, 2, 4 and 8 seconds after the one before, then every 8.
  const asked: number[] = [];
  for (let ms = 0; ms <= 32_000; ms += 100) {
    vi.advanceTimersByTime(100);
    if (w.sent.length > asked.length) asked.push(ms + 100);
  }
  expect(asked).toEqual([300, 1300, 3300, 7300, 15_300, 23_300, 31_300]);
  expect(w.saving.unsaved).toBe(true);
  // The answer, when it does come, settles it.
  w.saving.answered({ n: 1, saved: true });
  expect(w.saving.unsaved).toBe(false);
});

test('a no, or a yes to an older question, does not settle it', () => {
  const w = watched();
  w.text.insert(0, 'a');
  vi.advanceTimersByTime(300);
  w.saving.answered({ n: 1, saved: false });
  expect(w.saving.unsaved).toBe(true);
  // More is typed before the first question's yes arrives.
  w.text.insert(1, 'b');
  w.saving.answered({ n: 1, saved: true });
  expect(w.saving.unsaved).toBe(true);
  vi.advanceTimersByTime(300);
  expect(w.sent.at(-1)!.n).toBe(2);
  w.saving.answered({ n: 2, saved: true });
  expect(w.saving.unsaved).toBe(false);
});

test('out of touch it sends nothing, and asks at once when back', () => {
  let online = false;
  const w = watched(() => online);
  w.text.insert(0, 'a');
  vi.advanceTimersByTime(20_000);
  expect(w.sent).toEqual([]);
  online = true;
  w.saving.reconnected();
  vi.advanceTimersByTime(50);
  expect(w.sent.map((q) => q.n)).toEqual([1]);
  // Nothing to ask about: coming back asks nothing.
  w.saving.answered({ n: 1, saved: true });
  w.saving.reconnected();
  vi.advanceTimersByTime(10_000);
  expect(w.sent).toHaveLength(1);
});

test("what arrives from someone else is not this copy's to save", () => {
  const w = watched();
  const other = new Y.Doc();
  other.getText('source').insert(0, 'theirs');
  Y.applyUpdate(w.doc, Y.encodeStateAsUpdate(other), 'remote');
  vi.advanceTimersByTime(10_000);
  expect(w.said).toEqual([]);
  expect(w.sent).toEqual([]);
});
