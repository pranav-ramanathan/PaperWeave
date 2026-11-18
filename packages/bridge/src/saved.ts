// Knowing, exactly, whether the server has everything this copy of a document changed.
// The sync library counts confirmations instead, and that count reaches zero early after a
// reconnect: edits queued while offline are confirmed after the count was reset.
import * as Y from 'yjs';

const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/**
 * Follow the changes made to a document here (not those that arrive from elsewhere), and build
 * the question that asks the server whether it holds all of them.
 */
export function localChanges(doc: Y.Doc, onChange: () => void = () => {}) {
  /** What was deleted here since the server last confirmed everything. */
  let deleted = Y.createDeleteSet();
  /** Goes up with every local change, so an answer can be matched to what was asked. */
  let version = 0;
  const watch = (tr: Y.Transaction) => {
    if (!tr.local) return;
    const me = doc.clientID;
    const inserted = (tr.afterState.get(me) ?? 0) !== (tr.beforeState.get(me) ?? 0);
    if (!inserted && !tr.deleteSet.clients.size) return;
    deleted = Y.mergeDeleteSets([deleted, tr.deleteSet]);
    version++;
    onChange();
  };
  doc.on('afterTransaction', watch);
  return {
    /**
     * "Do you have every insert and delete I have made?", as text to send. `n` comes back with
     * the answer. The inserts are named by how far this copy's own edits have got.
     */
    question() {
      const mine = new Map([[doc.clientID, Y.getState(doc.store, doc.clientID)]]);
      return { n: version, saved: base64(Y.encodeSnapshot(Y.createSnapshot(deleted, mine))) };
    },
    /** The server said yes to question `n`. True if nothing has changed here since it was asked. */
    confirmed(n: number) {
      if (n !== version) return false;
      deleted = Y.createDeleteSet();
      return true;
    },
    destroy: () => doc.off('afterTransaction', watch),
  };
}

/**
 * Keep the answer to "has the server got everything changed here?" up to date, by asking.
 *
 * It asks once typing pauses, and then again, less and less often, until the answer is yes. It
 * does not wait to be told no: a question that could not be sent, or whose answer never came,
 * would otherwise leave "saving" on the screen for good.
 */
export function watchSaved(
  doc: Y.Doc,
  opts: {
    /** Send a question to the server. */
    send(question: string): void;
    /** Whether a question can be sent now. */
    ready(): boolean;
    /** Called when the answer changes. */
    say(unsaved: boolean): void;
  },
) {
  let unsaved = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wait = 500;
  const askIn = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (opts.ready()) opts.send(JSON.stringify(changes.question()));
      askIn((wait = Math.min(wait * 2, 8000)));
    }, ms);
  };
  const changes = localChanges(doc, () => {
    unsaved = true;
    wait = 500;
    opts.say(true);
    // Asked once typing pauses, not after every key.
    askIn(300);
  });
  return {
    get unsaved() {
      return unsaved;
    },
    /** The server's answer to question `n`. A yes to an old question is not a yes to this one. */
    answered(reply: { n: number; saved: boolean }) {
      if (!reply.saved || !changes.confirmed(reply.n)) return;
      unsaved = false;
      clearTimeout(timer);
      opts.say(false);
    },
    /** Back in touch with the server: ask now, not when the next turn comes round. */
    reconnected() {
      if (!unsaved) return;
      wait = 500;
      askIn(50);
    },
    destroy() {
      clearTimeout(timer);
      changes.destroy();
    },
  };
}
