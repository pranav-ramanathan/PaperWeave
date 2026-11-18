// The durable side of live editing: who may open a file, the log of edits to it, and the text
// that log adds up to. The WebSocket server (apps/sync) calls these; it holds no state of its own
// that matters.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeFile, encodeFile } from '@paperweave/latex';
import type pg from 'pg';
import * as Y from 'yjs';
import { can, type Role, ROLES } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';

/** The name of the one shared text inside each file's Yjs document. */
export const TEXT = 'source';
const WRITERS = ROLES.filter((r) => can(r, 'file.write'));

const sign = (secret: string, body: string) =>
  createHmac('sha256', `sync-ticket:${secret}`).update(body).digest('base64url');

/** A short-lived proof of who is connecting, handed to the sync server instead of a cookie. */
export function syncTicket(secret: string, userId: string, seconds = 60) {
  const body = Buffer.from(
    JSON.stringify({ u: userId, e: Math.floor(Date.now() / 1000) + seconds }),
  ).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** The user a ticket was issued to, or null if it is forged, malformed or expired. */
export function verifyTicket(secret: string, ticket: unknown): string | null {
  if (typeof ticket !== 'string') return null;
  const [body, mac] = ticket.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return typeof u === 'string' && typeof e === 'number' && e >= Date.now() / 1000 ? u : null;
  } catch {
    return null;
  }
}

/** What the user may do with a file. Someone not on the paper gets `not_found`. */
export async function openFile(db: Db, userId: string, fileId: string) {
  const { rows } = await db.query(
    `select f.project_id as "projectId", f.path, f.eol, m.role from files f
     join project_members m on m.project_id = f.project_id and m.user_id = $2 where f.id = $1`,
    [id(fileId), userId],
  );
  const f = rows[0] as
    { projectId: string; path: string; eol: string | null; role: Role } | undefined;
  if (!f) throw new AppError('not_found', 'No such file.');
  // A file that is not editable text (an image, a file in another encoding) is never opened live.
  if (!f.eol) throw new AppError('invalid_input', 'This file cannot be edited as text.');
  return {
    projectId: f.projectId,
    path: f.path,
    role: f.role,
    canWrite: can(f.role, 'file.write'),
  };
}

/**
 * Append one edit to a file's log, but only if the user may write to it right now. Returns the
 * edit's place in the log, or null if it was refused. The check and the write are one statement,
 * so a role taken away a moment ago is already taken away here.
 */
export async function appendUpdate(
  db: Db,
  fileId: string,
  userId: string,
  update: Uint8Array,
): Promise<number | null> {
  const { rows } = await db.query(
    `with allowed as (
       select f.id from files f join project_members m on m.project_id = f.project_id
       where f.id = $1 and m.user_id = $2 and m.role = any($4) and f.eol is not null
     ), head as (
       update files set head_seq = head_seq + 1 where id in (select id from allowed) returning head_seq
     )
     insert into file_updates (file_id, seq, update, user_id) select $1, head_seq, $3, $2 from head returning seq`,
    [fileId, userId, Buffer.from(update), WRITERS],
  );
  return rows[0] ? Number(rows[0].seq) : null;
}

/**
 * Every edit to a file, oldest first. The first time a file is opened, its bytes become the
 * first edit, written once so that every later reader builds on the same history.
 */
export async function loadUpdates(
  pool: pg.Pool,
  store: BlobStore,
  fileId: string,
): Promise<Uint8Array[]> {
  const existing = await readLog(pool, fileId);
  if (existing.length) return existing;
  return transaction(pool, (db) => lockedUpdates(db, store, fileId));
}
const readLog = async (db: Db, fileId: string) =>
  (
    await db.query('select update from file_updates where file_id = $1 order by seq', [fileId])
  ).rows.map((r) => new Uint8Array(r.update));

/** The same inside a transaction, which then holds the file: no edit lands until it ends. */
export async function lockedUpdates(
  db: Db,
  store: BlobStore,
  fileId: string,
): Promise<Uint8Array[]> {
  const file = (
    await db.query('select digest, eol, head_seq from files where id = $1 for update', [id(fileId)])
  ).rows[0];
  if (!file?.eol) throw new AppError('not_found', 'No such file.');
  if (Number(file.head_seq) > 0) return readLog(db, fileId);
  const bytes = await store.get(file.digest);
  const decoded = bytes && decodeFile(bytes);
  if (!decoded?.editable) throw new Error(`file ${fileId} has no readable text`);
  const doc = new Y.Doc();
  doc.getText(TEXT).insert(0, decoded.text);
  const update = Y.encodeStateAsUpdate(doc);
  await db.query('update files set head_seq = 1 where id = $1', [fileId]);
  await db.query('insert into file_updates (file_id, seq, update) values ($1, 1, $2)', [
    fileId,
    Buffer.from(update),
  ]);
  return [update];
}

/**
 * Edit a file from the server, as the user: what a restore does, and what commands will do. The
 * edit goes through the same log and the same permission check as typing, and the sync server is
 * told so that people with the file open see it at once.
 */
export function editFile(
  pool: pg.Pool,
  store: BlobStore,
  fileId: string,
  userId: string,
  change: (text: Y.Text) => void,
): Promise<void> {
  return transaction(pool, (db) => editLocked(db, store, fileId, userId, change));
}

/** The same as one step of a larger transaction. People see the edit when it commits. */
export async function editLocked(
  db: Db,
  store: BlobStore,
  fileId: string,
  userId: string,
  change: (text: Y.Text) => void,
): Promise<void> {
  const doc = new Y.Doc();
  for (const update of await lockedUpdates(db, store, fileId)) Y.applyUpdate(doc, update);
  const before = Y.encodeStateVector(doc);
  change(doc.getText(TEXT));
  const update = Y.encodeStateAsUpdate(doc, before);
  // Two zero bytes: nothing was inserted or deleted.
  if (update.length <= 2) return;
  const seq = await appendUpdate(db, fileId, userId, update);
  if (seq === null) throw new AppError('permission_denied', 'You cannot edit this file.');
  await db.query("select pg_notify('file_edits', $1)", [`${fileId}:${seq}`]);
}

/**
 * Rewrite a file's log as one entry that holds the same document. Returns how many entries went.
 * Typing waits for the moment this takes. Anyone who reconnects with older state still merges:
 * the one entry keeps every edit's identity, only not the text that was deleted.
 * Who made each edit is not kept past this point.
 */
export async function compactFile(pool: pg.Pool, fileId: string): Promise<number> {
  return transaction(pool, async (db) => {
    const file = (await db.query('select head_seq from files where id = $1 for update', [fileId]))
      .rows[0];
    if (!file) return 0;
    const { rows } = await db.query(
      'select update from file_updates where file_id = $1 order by seq',
      [fileId],
    );
    if (rows.length < 2) return 0;
    const doc = new Y.Doc();
    for (const r of rows) Y.applyUpdate(doc, new Uint8Array(r.update));
    await db.query('delete from file_updates where file_id = $1', [fileId]);
    // It takes the place of the newest entry, so the file's place in its history does not move.
    await db.query('insert into file_updates (file_id, seq, update) values ($1, $2, $3)', [
      fileId,
      file.head_seq,
      Buffer.from(Y.encodeStateAsUpdate(doc)),
    ]);
    // shortcut: a command's key is remembered for a day, so a retry later than that could apply
    // twice if the text still matched. Keep keys longer if clients ever retry across days.
    await db.query(
      "delete from file_commands where file_id = $1 and created_at < now() - interval '1 day'",
      [fileId],
    );
    return rows.length - 1;
  });
}

/**
 * Whether a document holds everything in a snapshot: every insert it counts and every delete it
 * lists. The sync server's copy only ever holds what is already in the log, so for that copy
 * "holds" means "saved".
 */
export function holds(doc: Y.Doc, snapshot: Uint8Array): boolean {
  const want = Y.decodeSnapshot(snapshot);
  for (const [client, clock] of want.sv) if (Y.getState(doc.store, client) < clock) return false;
  // Ranges of deleted text per author, adjoining ones merged, so one wanted range lies in one.
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

/** A file's bytes as they stand now: the uploaded bytes if nobody has edited it, else its text. */
export async function currentBytes(
  db: Db,
  store: BlobStore,
  file: {
    id: string;
    digest: string;
    eol: string | null;
    bom: boolean | null;
    head_seq: number | string;
  },
): Promise<Uint8Array> {
  // The first log entry is the upload itself, so a file is untouched until there is a second.
  if (!file.eol || Number(file.head_seq) <= 1) {
    const bytes = await store.get(file.digest);
    if (!bytes) throw new Error(`blob ${file.digest} is missing`);
    return bytes;
  }
  const doc = new Y.Doc();
  const { rows } = await db.query(
    'select update from file_updates where file_id = $1 order by seq',
    [file.id],
  );
  for (const r of rows) Y.applyUpdate(doc, new Uint8Array(r.update));
  return encodeFile(doc.getText(TEXT).toString(), {
    eol: file.eol as 'lf' | 'crlf',
    bom: !!file.bom,
  });
}
