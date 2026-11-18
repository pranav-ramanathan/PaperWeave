// The live-editing server. Hocuspocus carries the Yjs protocol and presence; everything that must
// survive a crash goes through packages/server before an edit is applied or acknowledged.
import { type Connection, Server } from '@hocuspocus/server';
import {
  AppError,
  appendUpdate,
  type BlobStore,
  compactFile,
  loadUpdates,
  openFile,
  runCommand,
  verifyTicket,
} from '@paperweave/server';
import pg from 'pg';
import * as Y from 'yjs';

type Context = { userId: string; projectId: string };

/** y-protocols sync message types. Step 1 only asks what the server has; 1 and 2 carry edits. */
const SYNC_STEP_1 = 0;
/** An update with no inserts and no deletes is two zero bytes. */
const isEmpty = (update: Uint8Array) => update.length <= 2;

export async function startSync(opts: {
  pool: pg.Pool;
  store: BlobStore;
  secret: string;
  port: number;
  databaseUrl: string;
  /** A file's log is rewritten as one entry each time it has grown by this many edits. */
  compactEvery?: number;
}) {
  const { pool, store, secret, compactEvery = 500 } = opts;
  const server = new Server<Context>({
    port: opts.port,
    quiet: true,

    async onAuthenticate({ token, documentName, connectionConfig }) {
      const userId = verifyTicket(secret, token);
      if (!userId) throw new Error('unauthorized');
      // Throws for anyone who is not on the paper: the connection is refused.
      const file = await openFile(pool, userId, documentName);
      connectionConfig.readOnly = !file.canWrite;
      return { userId, projectId: file.projectId };
    },

    async onLoadDocument({ document, documentName }) {
      for (const update of await loadUpdates(pool, store, documentName))
        Y.applyUpdate(document, update);
    },

    // A structural edit, asked for by an editor. Messages on one connection are handled in order,
    // so every edit this person typed before asking is already in.
    async onStateless({ connection, document, documentName, payload }) {
      let key: unknown;
      const answer = (reply: object) => connection.sendStateless(JSON.stringify({ key, ...reply }));
      try {
        const c = JSON.parse(payload);
        key = c?.key;
        const bytes = (v: unknown) =>
          typeof v === 'string' ? Buffer.from(v, 'base64url') : undefined;
        const done = await runCommand(
          pool,
          store,
          (connection.context as Context).userId,
          documentName,
          { ...c, from: bytes(c?.from), to: bytes(c?.to) },
          { notify: false },
        );
        if (done.result !== 'applied') return answer({ result: done.result });
        // The author is answered first, with the edit, so that it is theirs to undo. Then it goes
        // to everyone with the file open, the author included, for whom it changes nothing more.
        answer({ result: 'applied', update: Buffer.from(done.update).toString('base64url') });
        Y.applyUpdate(document, done.update);
      } catch (err) {
        if (!(err instanceof AppError) && !(err instanceof SyntaxError))
          console.error(`command on ${documentName} failed:`, (err as Error).message);
        answer({ error: err instanceof AppError ? err.message : 'That edit could not be made.' });
      }
    },

    // Runs, and is awaited, before an incoming edit is applied and before it is acknowledged.
    // If the write fails this throws, the connection closes and the client resends on reconnect.
    async beforeSync({ type, payload, connection, context, documentName }) {
      if (type === SYNC_STEP_1 || connection.readOnly || isEmpty(payload)) return;
      const seq = await appendUpdate(pool, documentName, context.userId, payload);
      // Write access was taken away since connecting. Hocuspocus now answers "not saved" and
      // does not apply the edit.
      if (seq === null) connection.readOnly = true;
      else if (seq % compactEvery === 0)
        // Not waited for: the edit is saved already, and this only tidies the log behind it.
        compactFile(pool, documentName).catch((err) =>
          console.error(`compacting ${documentName} failed:`, (err as Error).message),
        );
    },
  });

  // When someone's role changes or they are removed, re-check their open connections at once.
  const listener = new pg.Client({ connectionString: opts.databaseUrl });
  await listener.connect();
  await listener.query('listen acl');
  await listener.query('listen file_edits');
  listener.on('notification', async ({ channel, payload }) => {
    if (channel === 'file_edits') {
      // An edit made on the server (a restore, say): it is already in the log, so it only needs
      // to reach the people who have the file open.
      const [fileId, seq] = (payload ?? '').split(':');
      const document = server.hocuspocus.documents.get(fileId);
      if (!document) return;
      const { rows } = await pool.query(
        // That entry and any after it: if the log was compacted since, the edit is in a later one.
        'select update from file_updates where file_id = $1 and seq >= $2 order by seq',
        [fileId, seq],
      );
      for (const r of rows) Y.applyUpdate(document, new Uint8Array(r.update));
      return;
    }
    const projectId = payload;
    for (const [name, document] of server.hocuspocus.documents) {
      for (const connection of document.getConnections() as Connection<Context>[]) {
        if (connection.context.projectId !== projectId) continue;
        try {
          connection.readOnly = !(await openFile(pool, connection.context.userId, name)).canWrite;
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          // The reason tells the editor this is final, not a dropped connection.
          connection.close({ code: 4403, reason: 'no-access' });
        }
      }
    }
  });

  await server.listen();
  return {
    port: opts.port,
    async stop() {
      await listener.end();
      await server.destroy();
    },
  };
}
