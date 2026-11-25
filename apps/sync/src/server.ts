// The live-editing server. Hocuspocus carries the Yjs protocol and presence; everything that must
// survive a crash goes through packages/server before an edit is applied or acknowledged.
import { type Connection, Server } from '@hocuspocus/server';
import {
  AppError,
  appendUpdate,
  type BlobStore,
  COMPACT_BYTES,
  COMPACT_ENTRIES,
  compactIfDue,
  type EditBudgetConfig,
  editBudget,
  envCount,
  editBudgetFromEnv,
  cleanPresence,
  holds,
  listen,
  loadUpdates,
  openFile,
  MAX_AWARENESS_BYTES,
  MAX_EDIT_BYTES,
  presenceSize,
  restoreNote,
  runCommand,
  tooLarge,
  verifyTicket,
} from '@paperweave/server';
import pg from 'pg';
import * as Y from 'yjs';
import { metricsText, newCounts, serveMetrics } from './metrics.ts';

/** Who a connection is, on which paper, in what role, and under which sign-in (null for a
 * ticket that names none). */
type Context = {
  userId: string;
  projectId: string;
  sessionId: string | null;
  role: string;
  /** Whether the role may write, as last looked up. Who is charged for edits goes by this. */
  canWrite: boolean;
  /** Which connection this was to its server, in the order they were let past the ticket. */
  n: number;
  /** What the editor shows for this person (their email): the name their presence goes under. */
  name: string;
  /** The Yjs client IDs this connection has claimed for its presence. Held in memory only. */
  claims: Set<number>;
};

/** The most client IDs one connection may claim. An editor uses one. */
const MAX_CLAIMS = 8;

/** The most connections one person may hold open: to one file, and to all files together. */
export type ConnectionCap = { perFile: number; perPerson: number };
/** A live connection, as `overCap` sees it. */
export type OpenConnection = { userId: string; fileId: string; n: number };

/**
 * Whether connection number `n` of a person to a file is over the cap. It counts that person's
 * live connections that came before it (a lower `n`), to the file and in all: the newest is the
 * one refused, and tabs already open are left alone. A connection that is not yet among `open`
 * asks with `Infinity`, which counts them all.
 */
export function overCap(
  open: readonly OpenConnection[],
  userId: string,
  fileId: string,
  n: number,
  cap: ConnectionCap,
) {
  const before = open.filter((c) => c.userId === userId && c.n < n);
  return (
    before.length >= cap.perPerson ||
    before.filter((c) => c.fileId === fileId).length >= cap.perFile
  );
}

/** y-protocols sync message types. Step 1 only asks what the server has; 1 and 2 carry edits. */
const SYNC_STEP_1 = 0;
/** An update with no inserts and no deletes is two zero bytes. */
const isEmpty = (update: Uint8Array) => update.length <= 2;
/** What an editor is told when the server cannot say yet whether it may connect. */
const TRY_AGAIN = 'try-again';
/** Why the server closes a connection whose edit it will not take. The editor knows the word. */
export const TOO_LARGE = 'too-large';
/** Why it closes a connection whose person has sent too many edits lately. Not final: the editor waits. */
export const OVER_BUDGET = 'over-budget';
/** Why it closes a connection that sent a presence message too large to be read. Not final. */
export const PRESENCE_TOO_LARGE = 'presence-too-large';
/** Why it refuses or closes a connection when its person already has too many open. Not final. */
export const TOO_MANY = 'too-many';

export async function startSync(opts: {
  pool: pg.Pool;
  store: BlobStore;
  secret: string;
  port: number;
  databaseUrl: string;
  /** A file's log is rewritten as one entry once it holds this many edits... */
  compactEvery?: number;
  /** ...or this many bytes past its first entry (`SYNC_COMPACT_BYTES`). */
  compactBytes?: number;
  /** Whoever sends this token may read /metrics. Without one there is no such page. */
  metricsToken?: string;
  /** The longest a file's text may be made by editing. The default is what could be imported. */
  maxFileText?: number;
  /** How much each person may send in edits: the most at once, what is given back a minute, and
   * the least an edit costs. The burst must hold the largest edit. */
  editBudget?: EditBudgetConfig;
  /**
   * How often to look for sign-ins that have run out. Fixed at a minute in the service; only
   * tests shorten it.
   */
  sessionCheckMs?: number;
  /** The most connections a person may hold open, to one file and in all. */
  connectionCap?: ConnectionCap;
}) {
  const { pool, store, secret, compactEvery = COMPACT_ENTRIES, sessionCheckMs = 60_000 } = opts;
  const compactBytes = opts.compactBytes ?? envCount('SYNC_COMPACT_BYTES', COMPACT_BYTES);
  const cap = opts.connectionCap ?? { perFile: 8, perPerson: 64 };
  const counts = newCounts();
  /** The last number given to a connection. Only counts up; what is live is asked of the library. */
  let seq = 0;
  /** Every live connection, as the library tracks them: it drops one when its socket closes. */
  const live = (): OpenConnection[] =>
    [...server.hocuspocus.documents].flatMap(([fileId, document]) =>
      (document.getConnections() as Connection<Context>[]).map((c) => ({
        userId: c.context.userId,
        fileId,
        n: c.context.n,
      })),
    );
  const config = opts.editBudget ?? editBudgetFromEnv();
  const floor = config.floor;
  if (config.burst < MAX_EDIT_BYTES)
    throw new Error(
      `the edit budget's burst (${config.burst} bytes) is below the largest edit (${MAX_EDIT_BYTES}): check SYNC_EDIT_BURST_BYTES`,
    );
  const budget = editBudget(config);
  // Presence is charged apart from edits, a message at a time: a person's cursor moving is
  // many small messages, and must never use up what their edits may send, nor the other way.
  const presenceBudget = editBudget({ burst: 2000, perMinute: 1200, floor: 1 });
  /**
   * Connections closed because of an edit the server would not take (too large, over budget).
   * The library goes on through what was already queued on such a connection, and a later look at
   * the person's role can make it writable again: nothing more is taken from it, whatever its
   * `readOnly` says.
   */
  const shut = new WeakSet<Connection<Context>>();
  /** Which connection holds each Yjs client ID in a file's presence. Released on disconnect. */
  const owners = new Map<string, Map<number, Context>>();
  const BUDGET_MESSAGE = 'Too many edits at once. Try again in a moment.';
  /** For a file being read from its log: where the log stood when the reading began. */
  const loadedAt = new Map<string, number>();
  /**
   * What this server has saved to each file since it last looked at whether its log is due to be
   * rewritten. Edits made elsewhere (restores, commands) look after the log themselves; the
   * database is asked only on a file's first edit after start and when this passes a threshold.
   */
  const tally = new Map<string, { entries: number; bytes: number }>();
  const due = { entries: compactEvery, bytes: compactBytes };
  const tidy = (fileId: string, bytes: number) => {
    const t = tally.get(fileId);
    if (t) {
      t.entries++;
      t.bytes += bytes;
      if (t.entries < due.entries && t.bytes < due.bytes) return;
    }
    tally.set(fileId, { entries: 0, bytes: 0 });
    compactIfDue(pool, fileId, due).then(
      (gone) => void (gone > 0 && counts.compactions++),
      (err) => console.error(`compacting ${fileId} failed:`, (err as Error).message),
    );
  };
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
   * to their logs first, so the restored text reaches each socket before this does. With the
   * number goes who restored it and to what, for the editor to say: read once, and left out if
   * it cannot be read (the number is what the editor's own bookkeeping needs).
   */
  const tellRestored = async (projectId: string, n: number, catchUpFirst = true) => {
    const here = (document: { getConnections(): unknown[] }) =>
      (document.getConnections() as Connection<Context>[]).filter(
        (c) => c.context.projectId === projectId,
      );
    // Nobody has the paper open: nothing to read, nobody to tell.
    if (![...server.hocuspocus.documents.values()].some((d) => here(d).length)) return;
    const restore = n > 0 ? await restoreNote(pool, projectId, n).catch(() => null) : null;
    for (const [name, document] of [...server.hocuspocus.documents]) {
      const mine = here(document);
      if (!mine.length) continue;
      if (catchUpFirst) await catchUp(name, 1);
      // Hocuspocus holds document updates until the end of this turn of the event loop, but
      // sends a stateless message at once: send what it holds first, or the signal outruns it.
      document.flush();
      for (const c of mine)
        c.sendStateless(JSON.stringify({ restored: n, ...(restore && { restore }) }));
    }
  };
  /**
   * Tell the editors of a paper that its list of files changed: one was added, removed or
   * renamed. Each asks the web app for the list; nothing of it is sent from here.
   */
  const tellFiles = (projectId: string) => {
    for (const document of server.hocuspocus.documents.values())
      for (const c of document.getConnections() as Connection<Context>[])
        if (c.context.projectId === projectId) c.sendStateless(JSON.stringify({ files: true }));
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
        // Before anything is looked up for it. Connections still on their way in are not among
        // the live ones, so this alone cannot hold a burst: `connected` ranks them again.
        if (overCap(live(), userId, documentName, Infinity, cap)) {
          counts.connectionsOverLimit++;
          throw Object.assign(new Error('too many connections'), { reason: TOO_MANY });
        }
        const n = ++seq;
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
        return {
          userId,
          projectId: file.projectId,
          sessionId,
          role: file.role,
          canWrite: file.canWrite,
          n,
          name: file.email,
          claims: new Set<number>(),
        };
      } catch (err) {
        counts.refusedConnections++;
        throw err;
      }
    },

    async onDisconnect({ context, documentName }) {
      counts.disconnections++;
      // Its client IDs are free to be claimed again, by a tab that reconnects with the same one.
      const held = owners.get(documentName);
      for (const id of (context as Context | undefined)?.claims ?? [])
        if (held?.get(id) === context) held.delete(id);
      if (held && !held.size) owners.delete(documentName);
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
      // Connections that were let in together each saw too few others: ranked now, by the
      // order they came, among those still live. Before anything is looked up or told.
      if (overCap(live(), context.userId, documentName, context.n, cap)) {
        counts.connectionsOverLimit++;
        return connection.close({ code: 4429, reason: TOO_MANY });
      }
      // A connection is not known to `recheck` or `signedOut` until the file has been read, which
      // can take a while. Whatever changed meanwhile is looked for here, before it is told or
      // given anything.
      try {
        if (await look(connection, documentName)) return;
        if (context.sessionId !== null) {
          const { rowCount } = await pool.query(
            'select 1 from session where id::text = $1 and "expiresAt" > now()',
            [context.sessionId],
          );
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
        const { userId, canWrite } = connection.context as Context;
        // Closed for an edit it sent: whatever else it had queued is not taken.
        if (shut.has(connection)) return answer({ error: 'That edit could not be made.' });
        // A writer's structural edits cost what they add, or the least an edit costs. Charged
        // before anything is done, from the length of the replacement (the edit adds a little
        // more than that: made up in `within`, below). Keyed by who the ticket says this is,
        // never by anything the client sent.
        const replacement = typeof c?.replacement === 'string' ? c.replacement : '';
        const charged = Math.max(Buffer.byteLength(replacement), floor);
        if (canWrite && !budget.take(userId, charged)) {
          counts.editsOverBudget++;
          return answer({ error: BUDGET_MESSAGE });
        }
        const bytes = (v: unknown) =>
          typeof v === 'string' ? Buffer.from(v, 'base64url') : undefined;
        const began = Date.now();
        const done = await runCommand(
          pool,
          store,
          userId,
          documentName,
          { ...c, from: bytes(c?.from), to: bytes(c?.to) },
          {
            notify: false,
            maxFileText: opts.maxFileText,
            exactPlace: true,
            // The edit as appended is known only inside the transaction that appends it. What it
            // comes to beyond what was charged is taken now; if that is not there, the
            // transaction is undone and nothing is applied.
            within: async (_db, _placed, appended) => {
              if (canWrite && appended > charged && !budget.take(userId, appended - charged)) {
                counts.editsOverBudget++;
                throw new AppError('conflict', BUDGET_MESSAGE);
              }
            },
          },
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

    // Before the library reads a message at all, so before it parses presence. The library has
    // no way to drop a message from here: throwing is the only way to refuse one, and it closes
    // the connection, with the reason. Only a client that is not ours sends this much presence:
    // the editor cuts what it sends to a few hundred bytes.
    async beforeHandleMessage({ update }) {
      const size = presenceSize(update);
      if (size !== null && size > MAX_AWARENESS_BYTES) {
        counts.presenceDropped++;
        throw Object.assign(new Error('presence message too large'), {
          reason: PRESENCE_TOO_LARGE,
        });
      }
    },

    // Presence from anyone on the file, viewers and reviewers included: it is not an edit, and
    // not held back by role. What it may say is cut to what the editors send, and each person
    // may send so many a minute. Emptying both sets drops the message and keeps the connection.
    async beforeHandleAwareness({ states, removedClients, context, documentName }) {
      const over = !!context && !presenceBudget.take(context.userId, 1);
      if (over) {
        states.clear();
        removedClients.clear();
        counts.presenceDropped++;
        return;
      }
      // Presence is the connection's own: under the name the server knows, and only under client
      // IDs it holds. Without a context there is no connection to hold anything for.
      const who = context && {
        name: context.name,
        owns: (id: number) => context.claims.has(id),
        claim: (id: number) => {
          if (context.claims.has(id)) return true;
          const held = owners.get(documentName) ?? new Map<number, Context>();
          if (held.has(id) || context.claims.size >= MAX_CLAIMS) return false;
          held.set(id, context);
          owners.set(documentName, held);
          context.claims.add(id);
          return true;
        },
      };
      if (cleanPresence(states, removedClients, who)) counts.presenceDropped++;
    },

    // Runs, and is awaited, before an incoming edit is applied and before it is acknowledged.
    // If the write fails this throws, the connection closes and the client resends on reconnect.
    async beforeSync({ type, payload, connection, context, document, documentName }) {
      if (type === SYNC_STEP_1 || isEmpty(payload)) return;
      // Closed for an earlier edit, and a look at its role since may have made it writable.
      if (shut.has(connection)) connection.readOnly = true;
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
        shut.add(connection);
        connection.readOnly = true;
        connection.close({ code: 1009, reason: TOO_LARGE });
        return;
      }
      // Only now: an edit refused as too large is not charged. Not saved and not applied either.
      // The editor sends it again on reconnect, and is let in once the budget has refilled; until
      // then it is told why, and waits.
      if (!budget.take(context.userId, payload.length)) {
        counts.editsOverBudget++;
        shut.add(connection);
        connection.readOnly = true;
        connection.close({ code: 1013, reason: OVER_BUDGET });
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
      // Not waited for: the edit is saved already, and this only tidies the log behind it.
      tidy(documentName, payload.length);
    },
  });

  /**
   * Look again at what one connection may do: set whether it may write, tell its editor if its
   * role changed, and close it for good if its person is off the paper. True if it was closed.
   */
  const look = async (connection: Connection<Context>, name: string) => {
    try {
      const file = await openFile(pool, connection.context.userId, name);
      connection.readOnly = shut.has(connection) || !file.canWrite;
      connection.context.canWrite = file.canWrite;
      connection.context.name = file.email;
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
  /**
   * Close the editors opened under sign-ins that have ended (deleted, or run out): these, or
   * any that have.
   */
  const signedOut = async (ended?: string) => {
    const open = [...server.hocuspocus.documents.values()].flatMap(
      (document) => document.getConnections() as Connection<Context>[],
    );
    let gone = new Set(ended ? [ended] : []);
    if (!ended) {
      const ids = [...new Set(open.map((c) => c.context.sessionId).filter((id) => id !== null))];
      if (!ids.length) return;
      const { rows } = await pool.query(
        'select id::text from session where id::text = any($1) and "expiresAt" > now()',
        [ids],
      );
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
  // server, and when someone signs out. A sign-in that merely runs out announces nothing: that
  // is found by the timed check below, and when a connection is made.
  const stopListening = await listen(
    opts.databaseUrl,
    ['acl', 'file_edits', 'session_ended', 'restored', 'files'],
    async (channel, payload) => {
      if (channel === 'session_ended') return signedOut(payload);
      if (channel === 'files') return tellFiles(payload);
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
        // Nor was a file added, removed or renamed meanwhile.
        tellFiles(projectId);
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
  // Sign-ins that run out are not deleted, so nothing announces them: look every so often.
  // A failed look closes no one; the next one tries again.
  let checking = false;
  const sweep = setInterval(() => {
    if (checking) return;
    checking = true;
    signedOut()
      .catch((err) => console.error('could not check which sign-ins have run out:', err.message))
      .finally(() => {
        checking = false;
      });
  }, sessionCheckMs);
  sweep.unref();

  await server.listen();
  return {
    port: opts.port,
    async stop() {
      clearInterval(clock);
      clearInterval(sweep);
      await stopListening();
      await server.destroy();
    },
  };
}
