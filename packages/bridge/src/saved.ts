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
