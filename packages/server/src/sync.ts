// The durable side of live editing: who may open a file, the log of edits to it, and the text
// that log adds up to. The WebSocket server (apps/sync) calls these; it holds no state of its own
// that matters.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeFile, encodeFile } from '@paperweave/latex';
import type pg from 'pg';
import * as Y from 'yjs';
import { LIMITS } from './archive.ts';
import { can, type Role, ROLES } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { remembered } from './scope.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';

/** The name of the one shared text inside each file's Yjs document. */
export const TEXT = 'source';
const WRITERS = ROLES.filter((r) => can(r, 'file.write'));

/** The largest single edit that is taken, in bytes as it arrives. */
export const MAX_EDIT_BYTES = 2_000_000;
/** The longest a file's text may be made by editing: what could have been imported. */
export const MAX_FILE_TEXT = LIMITS.fileBytes;

/**
 * Whether an edit is too large to take: by itself, or for what it would make of the file.
 * An edit is never smaller than the text it adds, so the file is only measured, on a copy, when
 * the edit could take it over the limit.
 */
export function tooLarge(document: Y.Doc, update: Uint8Array, max = MAX_FILE_TEXT) {
  if (update.length > MAX_EDIT_BYTES) return true;
  if (document.getText(TEXT).length + update.length <= max) return false;
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  Y.applyUpdate(copy, update);
  return copy.getText(TEXT).length > max;
}

const sign = (secret: string, body: string) =>
  createHmac('sha256', `sync-ticket:${secret}`).update(body).digest('base64url');

/**
 * A short-lived proof of who is connecting and to which file, handed to the sync server instead
 * of a cookie. It opens nothing else: taken from one file's page, it is no use on another. It
 * names the sign-in it was given under, so that the connection can be closed when that ends.
 */
export function syncTicket(
  secret: string,
  userId: string,
  fileId: string,
  seconds = 60,
  sessionId?: string,
) {
  const body = Buffer.from(
    JSON.stringify({
      u: userId,
      f: fileId,
      e: Math.floor(Date.now() / 1000) + seconds,
      s: sessionId,
    }),
  ).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/**
 * The user a ticket was issued to and the sign-in it was issued under, or null if it is forged,
 * malformed, expired or for another file.
 */
export function verifyTicket(
  secret: string,
  ticket: unknown,
  fileId: string,
): { userId: string; sessionId: string | null } | null {
  if (typeof ticket !== 'string') return null;
  const [body, mac] = ticket.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const { u, f, e, s } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return typeof u === 'string' && f === fileId && typeof e === 'number' && e >= Date.now() / 1000
      ? { userId: u, sessionId: typeof s === 'string' ? s : null }
      : null;
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
       update files set head_seq = head_seq + 1 where id in (select id from allowed) and deleted_at is null returning head_seq
     )
     insert into file_updates (file_id, seq, update, user_id) select $1, head_seq, $3, $2 from head returning seq`,
    [fileId, userId, Buffer.from(update), WRITERS],
  );
  return rows[0] ? Number(rows[0].seq) : null;
}

/**
 * Append one edit to each of several files of one paper, in one statement: the same check as
 * `appendUpdate` (the user may write to the paper right now, the file is editable text), made
 * once, then every file's place in its log taken and its edit written. Returns each file's
 * place. Throws `permission_denied` if any was refused, so that the caller's transaction ends.
 */
export async function appendUpdates(
  db: Db,
  projectId: string,
  userId: string,
  items: { fileId: string; update: Uint8Array }[],
): Promise<Map<string, number>> {
  const seqs = new Map<string, number>();
  if (!items.length) return seqs;
  const { rows } = await db.query(
    `with allowed as (
       select 1 from project_members m where m.project_id = $1 and m.user_id = $2 and m.role = any($5)
     ), head as (
       update files set head_seq = head_seq + 1
       where id = any($3::uuid[]) and project_id = $1 and eol is not null and deleted_at is null
         and exists (select 1 from allowed)
       returning id, head_seq
     )
     insert into file_updates (file_id, seq, update, user_id)
     select h.id, h.head_seq, u.update, $2 from head h
     join unnest($3::uuid[], $4::bytea[]) as u(id, update) on u.id = h.id
     returning file_id, seq`,
    [
      projectId,
      userId,
      items.map((i) => i.fileId),
      items.map((i) => Buffer.from(i.update)),
      WRITERS,
    ],
  );
  for (const r of rows) seqs.set(r.file_id, Number(r.seq));
  if (seqs.size !== new Set(items.map((i) => i.fileId)).size)
    throw new AppError('permission_denied', 'You cannot edit this file.');
  return seqs;
}

/** Tell the sync server of edits already appended, in one statement. */
export async function notifyEdits(db: Db, edits: Map<string, number>): Promise<void> {
  if (!edits.size) return;
  await db.query("select pg_notify('file_edits', x) from unnest($1::text[]) as x", [
    [...edits].map(([fileId, seq]) => `${fileId}:${seq}`),
  ]);
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
    // Who wrote the edits is not kept past this point; that they wrote to this paper is.
    await db.query(
      `insert into project_authors (project_id, user_id)
       select distinct f.project_id, u.user_id from file_updates u
       join all_files f on f.id = u.file_id where u.file_id = $1 and u.user_id is not null
       on conflict do nothing`,
      [fileId],
    );
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
  const { rows } = await db.query(
    'select update from file_updates where file_id = $1 order by seq',
    [file.id],
  );
  return bytesOfLog(
    file,
    rows.map((r) => new Uint8Array(r.update)),
  );
}

/** What a file's edited log adds up to, as the bytes of the file. */
export function bytesOfLog(
  file: { eol: string | null; bom: boolean | null },
  updates: Uint8Array[],
): Uint8Array {
  const doc = new Y.Doc();
  for (const u of updates) Y.applyUpdate(doc, u);
  return encodeFile(doc.getText(TEXT).toString(), {
    eol: file.eol as 'lf' | 'crlf',
    bom: !!file.bom,
  });
}

/** The logs of many files in one statement, each oldest edit first. A file with none is absent. */
export async function readLogs(db: Db, fileIds: string[]): Promise<Map<string, Uint8Array[]>> {
  const logs = new Map<string, Uint8Array[]>();
  if (!fileIds.length) return logs;
  const { rows } = await db.query(
    'select file_id, update from file_updates where file_id = any($1) order by file_id, seq',
    [fileIds],
  );
  for (const r of rows) {
    const log = logs.get(r.file_id) ?? [];
    log.push(new Uint8Array(r.update));
    logs.set(r.file_id, log);
  }
  return logs;
}

/**
 * The logs of every file of a paper that has one, by file, in one go. In a request's scope the
 * paper's threads and proposals share one reading. A file with no log yet is not in it: its
 * reader opens it with `loadUpdates`, which is what writes its first edit.
 */
export function docsOf(db: Db, projectId: string): Promise<Map<string, Uint8Array[]>> {
  return remembered(db, ['docs', projectId], async () => {
    const { rows } = await db.query(
      'select id from files where project_id = $1 and eol is not null and head_seq > 0',
      [projectId],
    );
    return readLogs(
      db,
      rows.map((r) => r.id),
    );
  });
}
