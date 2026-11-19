# To report to the sync library's authors

Three things in `@hocuspocus/server` and `@hocuspocus/provider` (both 4.8.0) that this project
works around. None has been reported: the session that found them could only write to this
repository. Each is written so that it can be filed as it stands.

## 1. Edits from a connection dropped early are applied after its document is unloaded

**Package:** `@hocuspocus/server`. **Cost here:** saved edits that the people in a file were
never sent (see "Saved edits that did not reach the people in the file" in `status.md`).

What happens:

1. Clients A and B are connected to a document. A has sent several updates that the server has
   not yet worked through, because `beforeSync` is asynchronous (here it writes to a database).
2. A's socket starts to close. The next time the server sends anything to A, `Connection.send`
   sees the socket closing and calls `Connection.close()`, which removes A from the document's
   connections at once. A's message queue goes on being processed.
3. B's socket closes. B has nothing queued. The document now has no connections, so it is
   unloaded immediately.
4. A's remaining updates are passed to `beforeSync` and applied to the unloaded document.
5. A new client C connects. A fresh document is loaded. C never receives what was applied in
   step 4, though the application's `beforeSync` has persisted it.

A lone client that leaves with updates queued is handled well: in a test here the document
stayed loaded until its updates had been processed, and a client arriving meanwhile received
them. The early removal in step 2, followed by another client leaving, is what goes wrong.

What would fix it: do not remove a connection from its document while it has queued messages,
or do not unload a document while any connection that was on it is still processing.

What this project does instead: after persisting an update in `beforeSync`, if the document it
was given is not the one in `hocuspocus.documents`, it applies the persisted updates to the one
that is. And when the first client connects to a freshly loaded document, it reads the store
once more from where the loading began (`apps/sync/src/server.ts`).

A test that makes it happen: "what someone typed as they left reaches whoever opens the file
next" in `apps/sync/src/sync.sandbox.test.ts`.

## 2. An exception in a `status` listener makes the provider reconnect a second later

**Package:** `@hocuspocus/provider`. **Cost here:** every file opened was connected to twice
(see "An editor dropped its first connection" in `status.md`). The exception was this
project's own mistake; what the library did with it made it hard to see.

`HocuspocusProviderWebsocket.createWebSocketConnection` emits `status: connecting` from inside
the executor of the promise that represents the connection attempt, before it stores that
promise's `resolve` and `reject`. If a listener throws:

- the executor throws, so the attempt's promise is rejected;
- the socket has already been created and goes on to connect and sync normally;
- the retry wrapper sees a failed attempt, waits `delay` (one second), and makes another,
  closing the working socket and clearing the message queue.

Nothing is logged. The first `status` event is emitted during the provider's constructor, so a
listener passed as `onStatus` that refers to the provider being constructed throws there.

What would help: emit the event after the attempt's promise is set up, or catch and report
exceptions from listeners rather than letting them reject the attempt.

## 3. `connect()` called while a disconnect is still closing is ignored

**Package:** `@hocuspocus/provider`. **Cost here:** an editor that stayed offline after the
network came back, until this project added a retry.

Calling `websocketProvider.connect()` while the previous socket is still closing returns
without connecting, and nothing connects later: `connect()` returns at once while the status
is still `connected`, which it is until the close has finished. This project asks again from a `status`
listener whenever the status becomes `disconnected` and it wants to be connected
(`FileEditor.tsx`), and its tests wait for the old connection to close before reconnecting.
