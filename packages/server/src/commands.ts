// Structural edits: replace one stretch of a file's text, but only if it still reads as the
// author saw it. Typing merges; a command either lands exactly as meant or not at all.
import type pg from 'pg';
import * as Y from 'yjs';
import type { BlobStore } from './blobs.ts';
import { transaction } from './db.ts';
import { AppError } from './errors.ts';
import { appendUpdate, loadUpdates, openFile, TEXT } from './sync.ts';

const MAX_TEXT = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Command = {
  /** Chosen by the client. A retry sends the same key and is applied once. */
  key: string;
  /** The stretch to replace, as encoded Yjs relative positions, so it follows other edits. */
  from: Uint8Array;
  to: Uint8Array;
  /** What the stretch said when the command was made. */
  expected: string;
  replacement: string;
};
export type CommandResult =
  | { result: 'applied' | 'duplicate' }
  /** The stretch has changed. Nothing was done; here is the text as it stands. */
  | { result: 'conflict'; text: string };

function check(input: unknown): Command & { at: [Y.RelativePosition, Y.RelativePosition] } {
  const c = input as Partial<Command> | null;
  const bad = (what: string) =>
    new AppError('invalid_input', `That edit cannot be applied: ${what}.`);
  if (!c || typeof c !== 'object') throw bad('it is not a command');
  if (typeof c.key !== 'string' || !UUID.test(c.key)) throw bad('its key is not valid');
  if (typeof c.expected !== 'string' || typeof c.replacement !== 'string')
    throw bad('its text is missing');
  if (c.expected.length > MAX_TEXT || c.replacement.length > MAX_TEXT) throw bad('it is too large');
  // Stored text has LF line ends only; the file's own style is put back on export.
  if (c.replacement.includes('\r')) throw bad('it has a carriage return');
  if (
    !(c.from instanceof Uint8Array) ||
    !(c.to instanceof Uint8Array) ||
    !c.from.length ||
    !c.to.length
  )
    throw bad('its place is missing');
  if (c.from.length > 100 || c.to.length > 100) throw bad('its place is malformed');
  try {
    const at: [Y.RelativePosition, Y.RelativePosition] = [
      Y.decodeRelativePosition(c.from),
      Y.decodeRelativePosition(c.to),
    ];
    return { ...(c as Command), at };
  } catch {
    throw bad('its place is malformed');
  }
}

/**
 * Apply a command to a file as the user. The check and the edit happen while the file's log is
 * held, so the text checked is the text edited: typing by others waits a moment, and of two
 * commands on the same stretch the second sees what the first did.
 */
export async function runCommand(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  fileId: string,
  command: unknown,
): Promise<CommandResult> {
  const c = check(command);
  if (!(await openFile(pool, userId, fileId)).canWrite)
    throw new AppError('permission_denied', 'You cannot edit this file.');
  // Makes sure the file's uploaded bytes are in the log as its first entry.
  await loadUpdates(pool, store, fileId);
  return transaction(pool, async (db) => {
    await db.query('select 1 from files where id = $1 for update', [fileId]);
    const seen = (await db.query('select file_id from file_commands where key = $1', [c.key]))
      .rows[0];
    if (seen) {
      if (seen.file_id === fileId) return { result: 'duplicate' };
      throw new AppError('invalid_input', 'That edit cannot be applied: its key was used before.');
    }
    const doc = new Y.Doc();
    const { rows } = await db.query(
      'select update from file_updates where file_id = $1 order by seq',
      [fileId],
    );
    for (const r of rows) Y.applyUpdate(doc, new Uint8Array(r.update));
    const text = doc.getText(TEXT);
    const [from, to] = c.at.map((p) => {
      const found = Y.createAbsolutePositionFromRelativePosition(p, doc);
      return found?.type === text ? found.index : -1;
    });
    const now = text.toString();
    if (from < 0 || to < from || now.slice(from, to) !== c.expected)
      return { result: 'conflict', text: now };

    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      text.delete(from, to - from);
      text.insert(from, c.replacement);
    });
    const update = Y.encodeStateAsUpdate(doc, before);
    // Two zero bytes: the replacement was empty and so was the stretch.
    if (update.length > 2) {
      // Write access is checked again here, in the statement that writes.
      const seq = await appendUpdate(db, fileId, userId, update);
      if (seq === null) throw new AppError('permission_denied', 'You cannot edit this file.');
      // Delivered when this transaction commits: people with the file open see the edit at once.
      await db.query("select pg_notify('file_edits', $1)", [`${fileId}:${seq}`]);
    }
    await db.query('insert into file_commands (key, file_id, user_id) values ($1, $2, $3)', [
      c.key,
      fileId,
      userId,
    ]);
    return { result: 'applied' };
  });
}
