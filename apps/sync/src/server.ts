// The live-editing server. Hocuspocus carries the Yjs protocol and presence; everything that must
// survive a crash goes through packages/server before an edit is applied or acknowledged.
import { type Connection, Server } from '@hocuspocus/server';
import {
  AppError,
  appendUpdate,
  type BlobStore,
  loadUpdates,
  openFile,
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
}) {
  const { pool, store, secret } = opts;
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

    // Runs, and is awaited, before an incoming edit is applied and before it is acknowledged.
    // If the write fails this throws, the connection closes and the client resends on reconnect.
    async beforeSync({ type, payload, connection, context, documentName }) {
      if (type === SYNC_STEP_1 || connection.readOnly || isEmpty(payload)) return;
      const seq = await appendUpdate(pool, documentName, context.userId, payload);
      // Write access was taken away since connecting. Hocuspocus now answers "not saved" and
      // does not apply the edit.
      if (seq === null) connection.readOnly = true;
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
        'select update from file_updates where file_id = $1 and seq = $2',
        [fileId, seq],
      );
      if (rows[0]) Y.applyUpdate(document, new Uint8Array(rows[0].update));
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
