'use client';

import { defaultKeymap } from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useRef, useState } from 'react';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';

// Must match TEXT in packages/server/src/sync.ts.
const TEXT = 'source';
// Must match the reason apps/sync/src/server.ts gives when it closes a file.
const NO_ACCESS = 'no-access';
// Presence colours, chosen to stay readable on white. People are told apart by name as well.
const COLOURS = ['#1f5fbf', '#8a4b00', '#1a7f55', '#9b2d86', '#b3261e', '#5b5bd6'];
const colourFor = (name: string) =>
  COLOURS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % COLOURS.length];

type Sync = { connected: boolean; loaded: boolean; unsynced: number; refused: boolean };

export default function SourceEditor(props: {
  fileId: string;
  path: string;
  canWrite: boolean;
  user: string;
  syncUrl: string;
}) {
  const { fileId, canWrite, user, syncUrl } = props;
  const host = useRef<HTMLDivElement>(null);
  const [sync, setSync] = useState<Sync>({
    connected: false,
    loaded: false,
    unsynced: 0,
    refused: false,
  });
  const [others, setOthers] = useState<string[]>([]);

  useEffect(() => {
    const doc = new Y.Doc();
    const text = doc.getText(TEXT);
    const update = (change: Partial<Sync>) => setSync((s) => ({ ...s, ...change }));
    const provider = new HocuspocusProvider({
      url: syncUrl,
      name: fileId,
      document: doc,
      // Asked for on every connection attempt: a ticket only lives for a minute.
      token: async () => (await (await fetch('/api/sync-ticket')).json()).ticket ?? '',
      onStatus: ({ status }) => update({ connected: status === 'connected' }),
      onSynced: () => update({ loaded: true }),
      onUnsyncedChanges: ({ number }) => update({ unsynced: number }),
      onAuthenticationFailed: () => refuse(),
      // The server closes a file it will no longer serve: access was taken away, or it was deleted.
      onClose: ({ event }) => event.reason === NO_ACCESS && refuse(),
    });
    const awareness = provider.awareness!;
    awareness.setLocalStateField('user', {
      name: user,
      color: colourFor(user),
      colorLight: colourFor(user) + '33',
    });
    const seen = () =>
      setOthers(
        [...awareness.getStates()]
          .filter(([id]) => id !== doc.clientID)
          .map(([, s]) => s.user?.name)
          .filter((n): n is string => typeof n === 'string'),
      );
    awareness.on('change', seen);

    const writable = new Compartment();
    const lock = (on: boolean) => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': `LaTeX source of ${props.path}` }),
          writable.of(lock(!canWrite)),
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          // One undo history per person: undo never takes back someone else's edit.
          yCollab(text, awareness, { undoManager: new Y.UndoManager(text) }),
        ],
      }),
    });

    // Typing into a file that is no longer served would go nowhere, so it stops.
    const refuse = () => {
      update({ refused: true });
      view.dispatch({ effects: writable.reconfigure(lock(true)) });
    };

    // Closing the tab with edits the server has not confirmed would lose them.
    const warn = (e: BeforeUnloadEvent) => {
      if (provider.hasUnsyncedChanges) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    // An open socket can sit silent for a long time after the network goes. When the browser
    // says it is offline, say so at once, and reconnect the moment it is back.
    const socket = provider.configuration.websocketProvider;
    const offline = () => socket.disconnect();
    const online = () => void socket.connect();
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', warn);
      view.destroy();
      provider.destroy();
      doc.destroy();
    };
    // The editor is rebuilt only when a different file is opened.
  }, [fileId, canWrite, user, syncUrl, props.path]);

  const waiting = `${sync.unsynced} edit${sync.unsynced === 1 ? '' : 's'}`;
  const status = sync.refused
    ? 'You no longer have access to this file, or it has been deleted.'
    : !sync.loaded
      ? 'Opening…'
      : !sync.connected
        ? `Offline. ${sync.unsynced ? `${waiting} waiting to be saved.` : 'Nothing is waiting to be saved.'}`
        : !canWrite
          ? 'Read only. You can read along but not edit.'
          : sync.unsynced
            ? `Saving ${waiting}…`
            : 'All edits saved.';
  return (
    <section aria-label={`Editor for ${props.path}`}>
      <div className="editor-bar">
        <code>{props.path}</code>
        <span role="status" aria-live="polite" data-state={sync.connected ? 'online' : 'offline'}>
          {status}
        </span>
        <span>
          {others.length ? `Also here: ${[...new Set(others)].join(', ')}` : 'Nobody else is here.'}
        </span>
      </div>
      <div className="source" ref={host} />
    </section>
  );
}
