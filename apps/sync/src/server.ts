// The live-editing server. Hocuspocus carries the Yjs protocol and presence; everything that must
// survive a crash goes through packages/server before an edit is applied or acknowledged.
import { type Connection, Server } from '@hocuspocus/server';
import {
  AppError,
  appendUpdate,
  type BlobStore,
  compactFile,
  holds,
  listen,
  loadUpdates,
  openFile,
  MAX_EDIT_BYTES,
  runCommand,
  tooLarge,
  verifyTicket,
} from '@paperweave/server';
import pg from 'pg';
import * as Y from 'yjs';
import { metricsText, newCounts, serveMetrics } from './metrics.ts';

/** Who a connection is, on which paper, in what role, and under which sign-in (null for a
 * ticket that names none). */
type Context = { userId: string; projectId: string; sessionId: string | null; role: string };

/** y-protocols sync message types. Step 1 only asks what the server has; 1 and 2 carry edits. */
const SYNC_STEP_1 = 0;
/** An update with no inserts and no deletes is two zero bytes. */
const isEmpty = (update: Uint8Array) => update.length <= 2;
/** What an editor is told when the server cannot say yet whether it may connect. */
const TRY_AGAIN = 'try-again';
/** Why the server closes a connection whose edit it will not take. The editor knows the word. */
export const TOO_LARGE = 'too-large';

export async function startSync(opts: {
  pool: pg.Pool;
  store: BlobStore;
  secret: string;
  port: number;
  databaseUrl: string;
  /** A file's log is rewritten as one entry each time it has grown by this many edits. */
  compactEvery?: number;
  /** Whoever sends this token may read /metrics. Without one there is no such page. */
  metricsToken?: string;
  /** The longest a file's text may be made by editing. The default is what could be imported. */
  maxFileText?: number;
}) {
  const { pool, store, secret, compactEvery = 500 } = opts;
  const counts = newCounts();
  /** For a file being read from its log: where the log stood when the reading began. */
  const loadedAt = new Map<string, number>();
  /**
   * Bring the open copy of a file up to its log, from a place in the log on. That entry and
   * any after it: if the log was rewritten as one entry since, the edit is in a later one.
   */
  const catchUp = async (fileId: string, from: number) => {
    const document = server.hocuspocus.documents.get(fileId);
    if (!document) return;
    const { rows } = await pool.query(
      'select update from file_updates where file_id = $1 and seq >= $2 order by seq',
      [fileId, from],
    );
    for (const r of rows) Y.applyUpdate(document, new Uint8Array(r.update));
  };
  /**
   * Tell an editor what its person's role is now. Its page shows what they could do when it
   * loaded: without this, someone whose role was lowered goes on typing into an editor that
   * says "saving" for ever.
   */
  const tellRole = (connection: Connection<Context>, role: string) =>
    connection.sendStateless(JSON.stringify({ role, canWrite: !connection.readOnly }));
  /**
   * Tell the editors of a paper that it was restored, as number `n`. Their files are brought up
   * to their logs first, so the restored text reaches each socket before this does.
   */
  const tellRestored = async (projectId: string, n: number, catchUpFirst = true) => {
    for (const [name, document] of [...server.hocuspocus.documents]) {
      const mine = (document.getConnections() as Connection<Context>[]).filter(
        (c) => c.context.projectId === projectId,
      );
      if (!mine.length) continue;
      if (catchUpFirst) await catchUp(name, 1);
      // Hocuspocus holds document updates until the end of this turn of the event loop, but
      // sends a stateless message at once: send what it holds first, or the signal outruns it.
      document.flush();
      for (const c of mine) c.sendStateless(JSON.stringify({ restored: n }));
    }
  };
  const server = new Server<Context>({
    port: opts.port,
    quiet: true,
    // Nothing larger is read off the wire, signed in or not. Above the largest edit that is
    // taken, so that an edit that is too large is normally refused below, with the reason.
    websocketOptions: { maxPayload: 2 * MAX_EDIT_BYTES },

    async onAuthenticate({ token, documentName, connectionConfig }) {
      try {
        const ticket = verifyTicket(secret, token, documentName);
        if (!ticket) throw new Error('unauthorized');
        const { userId, sessionId } = ticket;
        // Throws for anyone who is not on the paper: the connection is refused.
        const file = await openFile(pool, userId, documentName).catch((err) => {
          if (err instanceof AppError) throw err;
          // The database did not answer. That is not a refusal, which an editor takes as
          // final: it is told to try again.
          console.error(`could not look up who may open ${documentName}:`, err.message);
          throw Object.assign(new Error('unavailable'), { reason: TRY_AGAIN });
        });
        connectionConfig.readOnly = !file.canWrite;
        counts.connections++;
        return { userId, projectId: file.projectId, sessionId, role: file.role };
      } catch (err) {
        counts.refusedConnections++;
        throw err;
      }
    },

    async onDisconnect() {
      counts.disconnections++;
    },

    async onRequest({ request, response }) {
      const text = () => metricsText(pool, counts, server.hocuspocus.getConnectionsCount());
      // Rejecting with nothing tells the library the request has been answered.
      if (await serveMetrics(request, response, opts.metricsToken, text)) return Promise.reject();
    },

    async onLoadDocument({ document, documentName }) {
      // Where the log stood before it was read: anything saved after this is looked for again
      // once the file is open (see `connected`).
      const head = await pool.query('select head_seq from files where id = $1', [documentName]);
      loadedAt.set(documentName, Number(head.rows[0]?.head_seq ?? 0));
      for (const update of await loadUpdates(pool, store, documentName))
        Y.applyUpdate(document, update);
    },

    // An edit can be saved to a file's log while this copy of the file is being read from it,
    // by a connection that is on its way out (see beforeSync). So the first time someone is
    // let in to a freshly read copy, the log is read once more from where the reading began.
    async connected({ documentName, connection, context }) {
      // A connection is not known to `recheck` or `signedOut` until the file has been read, which
      // can take a while. Whatever changed meanwhile is looked for here, before it is told or
      // given anything.
      try {
        if (await look(connection, documentName)) return;
        if (context.sessionId !== null) {
          const { rowCount } = await pool.query('select 1 from session where id::text = $1', [
            context.sessionId,
          ]);
          if (!rowCount) return connection.close({ code: 4401, reason: 'signed-out' });
        }
      } catch (err) {
        // The database did not answer. Not final, as a refusal is, and not left open unchecked:
        // the editor is told to try again.
        console.error(`could not look up who may use ${documentName}:`, (err as Error).message);
        return connection.close({ code: 1013, reason: TRY_AGAIN });
      }
      // The page was made for the role its person had when it loaded. That may be a while ago.
      tellRole(connection, context.role);
      if (server.hocuspocus.documents.get(documentName) !== connection.document) {
        // Not seen to happen. If it did, this person would see nobody else's edits.
        console.error(`a connection to ${documentName} is on a copy that is not the open one`);
        counts.editsOffTheOpenCopy++;
        return connection.webSocket.close(4409, 'stale');
      }
      const from = loadedAt.get(documentName);
      if (from === undefined) return;
      loadedAt.delete(documentName);
      await catchUp(documentName, from + 1);
    },

    // An editor asks one of two things: whether the server has all its changes, or for a
    // structural edit. Messages on one connection are handled in order, so every edit this
    // person sent before asking has been dealt with.
    async onStateless({ connection, document, documentName, payload }) {
      let key: unknown;
      const answer = (reply: object) => connection.sendStateless(JSON.stringify({ key, ...reply }));
      try {
        const c = JSON.parse(payload);
        // "Do you have all my changes?" Asked by an editor before it says they are saved.
        if (typeof c?.saved === 'string')
          return connection.sendStateless(
            JSON.stringify({ n: c.n, saved: holds(document, Buffer.from(c.saved, 'base64url')) }),
          );
        key = c?.key;
        const bytes = (v: unknown) =>
          typeof v === 'string' ? Buffer.from(v, 'base64url') : undefined;
        const began = Date.now();
        const done = await runCommand(
          pool,
          store,
          (connection.context as Context).userId,
          documentName,
          { ...c, from: bytes(c?.from), to: bytes(c?.to) },
          { notify: false, maxFileText: opts.maxFileText },
        );
        // The editor waits eight seconds for an answer. One that took long was waiting for
        // something, and which file and how long is worth knowing. Never the text.
        if (Date.now() - began > 2000)
          console.error(`command on ${documentName} took ${Date.now() - began} ms`);
        if (done.result !== 'applied') {
          counts.commandsNotApplied++;
          return answer({ result: done.result });
        }
        counts.commandsApplied++;
        // The author is answered first, with the edit, so that it is theirs to undo. Then it goes
        // to everyone with the file open, the author included, for whom it changes nothing more.
        answer({ result: 'applied', update: Buffer.from(done.update).toString('base64url') });
        Y.applyUpdate(document, done.update);
      } catch (err) {
        if (!(err instanceof AppError) && !(err instanceof SyntaxError))
          console.error(`command on ${documentName} failed:`, (err as Error).message);
        counts.commandsNotApplied++;
        answer({ error: err instanceof AppError ? err.message : 'That edit could not be made.' });
      }
    },

    // Runs, and is awaited, before an incoming edit is applied and before it is acknowledged.
    // If the write fails this throws, the connection closes and the client resends on reconnect.
    async beforeSync({ type, payload, connection, context, document, documentName }) {
      if (type === SYNC_STEP_1 || isEmpty(payload)) return;
      if (connection.readOnly) {
        // Not saved and not applied. Everyone sends what they have deleted when they connect, so
        // only something this file does not already hold counts as an edit that was refused.
        if (!Y.snapshotContainsUpdate(Y.snapshot(document), payload)) counts.editsRejected++;
        return;
      }
      if (tooLarge(document, payload, opts.maxFileText)) {
        // Not saved and not applied. The editor would send it again on every reconnect, so the
        // connection is closed with the reason, and the editor stops and says so.
        counts.editsTooLarge++;
        connection.readOnly = true;
        connection.close({ code: 1009, reason: TOO_LARGE });
        return;
      }
      const seq = await appendUpdate(pool, documentName, context.userId, payload);
      // Write access was taken away since connecting. Hocuspocus now answers "not saved" and
      // does not apply the edit.
      if (seq === null) {
        counts.editsRejected++;
        connection.readOnly = true;
        return;
      }
      counts.editsSaved++;
      // The library drops a connection from its file as soon as its socket starts to close, and
      // goes on through the edits it had already sent. If it was the last one, the file is
      // unloaded meanwhile, and this edit is applied to a copy nobody is on. It is saved all the
      // same, so whoever has the file open by now is brought up to it.
      if (server.hocuspocus.documents.get(documentName) !== document) {
        counts.editsOffTheOpenCopy++;
        await catchUp(documentName, seq);
      }
      if (seq % compactEvery === 0)
        // Not waited for: the edit is saved already, and this only tidies the log behind it.
        compactFile(pool, documentName).then(
          () => void counts.compactions++,
          (err) => console.error(`compacting ${documentName} failed:`, (err as Error).message),
        );
    },
  });

  /**
   * Look again at what one connection may do: set whether it may write, tell its editor if its
   * role changed, and close it for good if its person is off the paper. True if it was closed.
   */
  const look = async (connection: Connection<Context>, name: string) => {
    try {
      const file = await openFile(pool, connection.context.userId, name);
      connection.readOnly = !file.canWrite;
      if (connection.context.role !== file.role) {
        connection.context.role = file.role;
        tellRole(connection, file.role);
      }
      return false;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      // The reason tells the editor this is final, not a dropped connection.
      connection.close({ code: 4403, reason: 'no-access' });
      return true;
    }
  };
  /** Look again at what each connection to a paper's files may do, or to every paper's. */
  const recheck = async (projectId?: string) => {
    for (const [name, document] of server.hocuspocus.documents) {
      for (const connection of document.getConnections() as Connection<Context>[]) {
        if (projectId && connection.context.projectId !== projectId) continue;
        await look(connection, name);
      }
    }
  };
  /** Close the editors opened under sign-ins that have ended: these, or any that are gone. */
  const signedOut = async (ended?: string) => {
    const open = [...server.hocuspocus.documents.values()].flatMap(
      (document) => document.getConnections() as Connection<Context>[],
    );
    let gone = new Set(ended ? [ended] : []);
    if (!ended) {
      const ids = [...new Set(open.map((c) => c.context.sessionId).filter((id) => id !== null))];
      if (!ids.length) return;
      const { rows } = await pool.query('select id::text from session where id::text = any($1)', [
        ids,
      ]);
      const still = new Set(rows.map((r) => r.id));
      gone = new Set(ids.filter((id) => !still.has(id)));
    }
    // Not for good, as far as this server knows: each asks for a new ticket, and gets one only
    // if still signed in.
    for (const connection of open)
      if (connection.context.sessionId !== null && gone.has(connection.context.sessionId))
        connection.close({ code: 4401, reason: 'signed-out' });
  };
  // Told at once when someone's role changes or they are removed, when an edit is made on the
  // server, and when someone signs out.
  const stopListening = await listen(
    opts.databaseUrl,
    ['acl', 'file_edits', 'session_ended', 'restored'],
    async (channel, payload) => {
      if (channel === 'session_ended') return signedOut(payload);
      if (channel === 'restored') {
        const [projectId, number] = payload.split(':');
        return tellRestored(projectId, Number(number));
      }
      if (channel === 'file_edits') {
        // An edit made on the server (a restore, say): it is already in the log, so it only
        // needs to reach the people who have the file open.
        const [fileId, seq] = payload.split(':');
        return catchUp(fileId, Number(seq));
      }
      await recheck(payload);
    },
    // The connection that listens was lost and made again. Whatever was announced meanwhile
    // was not heard, so everything it could have said is looked up: who may do what, who is
    // still signed in, and what each open file's log now holds.
    async () => {
      await recheck();
      await signedOut();
      for (const name of server.hocuspocus.documents.keys()) await catchUp(name, 1);
      // A restore announced meanwhile was not heard either: say where each open paper stands.
      const papers = new Set<string>();
      for (const document of server.hocuspocus.documents.values())
        for (const c of document.getConnections() as Connection<Context>[])
          papers.add(c.context.projectId);
      for (const projectId of papers) {
        const { rows } = await pool.query(
          "select coalesce(max(number), 0)::int as n from revisions where project_id = $1 and kind = 'restore'",
          [projectId],
        );
        await tellRestored(projectId, rows[0].n, false);
      }
    },
  );

  // When this process is kept from running (by its own work, or by the machine), everyone's
  // editing waits and nothing else says why. A clock that should tick every half second says so.
  let ticked = Date.now();
  const clock = setInterval(() => {
    const late = Date.now() - ticked - 500;
    if (late > 1000) console.error(`the sync server did not run for ${late} ms`);
    ticked = Date.now();
  }, 500);
  clock.unref();

  await server.listen();
  return {
    port: opts.port,
    async stop() {
      clearInterval(clock);
      await stopListening();
      await server.destroy();
    },
  };
}
