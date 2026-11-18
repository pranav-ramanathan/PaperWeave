// Shared by the sync server's tests: a client that connects the way the browser does.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { syncTicket, TEXT } from '@paperweave/server';
import * as Y from 'yjs';
import { localChanges } from '../../../packages/bridge/src/saved.ts';

const open: HocuspocusProvider[] = [];

/** Connect as a user to a file on the sync server at a port. */
export function connect(
  secret: string,
  user: { id: string },
  file: string,
  port: number,
  // A fresh ticket for every connection attempt, as the web app mints them.
  token = () => syncTicket(secret, user.id, file),
) {
  const doc = new Y.Doc();
  /** Answers from the server, each with the text this client held when it arrived. */
  const replies: {
    key?: string;
    result?: string;
    update?: string;
    error?: string;
    n?: number;
    saved?: boolean;
    had: string;
  }[] = [];
  const state = { refused: false, closed: 0, reasons: [] as string[], replies };
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}`,
    // Reconnect quickly. The library refuses a delay below its minimum, silently.
    delay: 50,
    minDelay: 50,
    maxDelay: 200,
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: file,
    document: doc,
    token,
    onAuthenticationFailed: () => void (state.refused = true),
    onClose: ({ event }) => {
      state.closed++;
      state.reasons.push(`${event.code}:${event.reason}`);
    },
    onStateless: ({ payload }) =>
      void replies.push({ ...JSON.parse(payload), had: doc.getText(TEXT).toString() }),
  });
  // A provider given its own socket does not start using it until told to.
  provider.attach();
  open.push(provider);
  return { doc, provider, socket, state, text: doc.getText(TEXT), changes: localChanges(doc) };
}
export type Client = ReturnType<typeof connect>;

/** Close every client a test opened. */
export function closeAll() {
  for (const p of open.splice(0)) {
    p.destroy();
    p.configuration.websocketProvider.destroy();
  }
}

export async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
/**
 * Wait until the server holds everything these clients have changed. Each asks, the way the
 * editor does, and asks again until the answer is yes to all of it.
 */
export const saved = (...cs: Client[]) =>
  until('edits to be saved', async () => {
    for (const c of cs) {
      if (!c.provider.synced) return false;
      const q = c.changes.question();
      c.provider.sendStateless(JSON.stringify(q));
      const end = Date.now() + 2000;
      while (!c.state.replies.some((r) => r.n === q.n && 'saved' in r)) {
        if (Date.now() > end) return false;
        await new Promise((r) => setTimeout(r, 5));
      }
      const yes = c.state.replies.some((r) => r.n === q.n && r.saved === true);
      if (!yes || !c.changes.confirmed(q.n)) return false;
    }
    return true;
  });
