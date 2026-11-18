'use client';

import { defaultKeymap } from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { Command, CommandResult } from '@paperweave/bridge';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { createVisual, type Visual } from '../../../../../lib/visual';

// Must match TEXT in packages/server/src/sync.ts.
const TEXT = 'source';
// Must match the reason apps/sync/src/server.ts gives when it closes a file.
const NO_ACCESS = 'no-access';
// Presence colours, chosen to stay readable on white. People are told apart by name as well.
const COLOURS = ['#1f5fbf', '#8a4b00', '#1a7f55', '#9b2d86', '#b3261e', '#5b5bd6'];
const colourFor = (name: string) =>
  COLOURS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % COLOURS.length];

type Sync = {
  connected: boolean;
  loaded: boolean;
  unsynced: number;
  refused: boolean;
  /** The paper was restored while this person was offline with edits of their own. */
  held: boolean;
};
type Mode = 'visual' | 'source';
/** The sync server's answer to a structural edit. */
type Reply = { result?: CommandResult; update?: string; error?: string };

const toBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

/**
 * One file, open for live editing. A .tex file has two views of the same text, visual and source;
 * anything else has the source view only.
 */
export default function FileEditor(props: {
  projectId: string;
  fileId: string;
  path: string;
  canWrite: boolean;
  user: string;
  syncUrl: string;
  /** Whether this file has a visual view at all. */
  visual: boolean;
  /** A file of definitions: its visual view shows it, but it is edited in source. */
  sourceOnly: boolean;
}) {
  const { projectId, fileId, canWrite, user, syncUrl, sourceOnly } = props;
  const host = useRef<HTMLDivElement>(null);
  const visualHost = useRef<HTMLDivElement>(null);
  const live = useRef<{ view: EditorView; visual: Visual | null; undo: Y.UndoManager }>(null);
  const [mode, setMode] = useState<Mode>(props.visual && !sourceOnly ? 'visual' : 'source');
  const [note, setNote] = useState('');
  // Until the editors exist there is no selection to carry: a click just changes the view.
  const switchTo = useRef<(next: Mode) => void>(setMode);
  const [sync, setSync] = useState<Sync>({
    connected: false,
    loaded: false,
    unsynced: 0,
    refused: false,
    held: false,
  });
  const keepEdits = useRef(() => {});
  const discardEdits = useRef(() => {});
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
      token: async () => {
        const { ticket, restored } = await (await fetch(`/api/sync-ticket?file=${fileId}`)).json();
        // Coming back online to a paper that was restored meanwhile: this person's unsent edits
        // were made to text that is no longer there. They are held until the person decides.
        if (restoreSeen !== null && restored !== restoreSeen && provider.hasUnsyncedChanges) {
          restoreHeld = restored;
          update({ held: true });
          setLocked(true);
          // Thrown, not sent: the connection attempt ends here, without bothering the server.
          throw new Error('held until the person decides');
        }
        restoreSeen = restored;
        return ticket ?? '';
      },
      onStatus: ({ status }) => {
        update({ connected: status === 'connected' });
        // "Apply my edits" closed the connection to open a fresh one: do that once it has closed.
        if (status === 'disconnected' && reopen) {
          reopen = false;
          void provider.configuration.websocketProvider.connect();
        }
      },
      onSynced: () => update({ loaded: true }),
      onUnsyncedChanges: ({ number }) => update({ unsynced: number }),
      onAuthenticationFailed: () => restoreHeld === null && refuse(),
      onStateless: ({ payload }) => {
        const reply: Reply & { key: string } = JSON.parse(payload);
        waiting.get(reply.key)?.(reply);
      },
      // The server closes a file it will no longer serve: access was taken away, or it was deleted.
      onClose: ({ event }) => event.reason === NO_ACCESS && refuse(),
    });
    /** The paper's newest restore when this tab last connected, and one found since, if held. */
    let restoreSeen: number | null = null;
    let restoreHeld: number | null = null;
    let reopen = false;
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

    // One undo history per person, for both views: undo never takes back someone else's edit.
    const undo = new Y.UndoManager(text);
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
          yCollab(text, awareness, { undoManager: undo }),
        ],
      }),
    });

    // A structural edit is checked and made by the server, against the text everyone shares.
    // It is asked for over the live connection, and the answer carries the edit.
    const waiting = new Map<string, (reply: Reply) => void>();
    const run = (c: Command) =>
      new Promise<CommandResult>((resolve, reject) => {
        const place = (p: Y.RelativePosition) => toBase64(Y.encodeRelativePosition(p));
        const timer = setTimeout(() => {
          waiting.delete(c.key);
          reject(new Error('no answer'));
        }, 8000);
        waiting.set(c.key, (reply) => {
          clearTimeout(timer);
          waiting.delete(c.key);
          if (!reply.result) return reject(new Error(reply.error));
          if (reply.update) {
            // Applied here as this person's own edit, and as an undo step of its own. The same
            // edit then arrives like anyone else's, and changes nothing more.
            undo.stopCapturing();
            Y.applyUpdate(doc, fromBase64(reply.update), visual!.bridge);
            undo.stopCapturing();
          }
          resolve(reply.result);
        });
        provider.sendStateless(JSON.stringify({ ...c, from: place(c.from), to: place(c.to) }));
      });
    const visual: Visual | null = props.visual
      ? createVisual({
          element: visualHost.current!,
          ytext: text,
          undo,
          label: `${props.path}, visual editor`,
          sourceOnly,
          editable: canWrite,
          say: setNote,
          showInSource: (from, to) => show('source', from, to),
          run,
        })
      : null;
    live.current = { view, visual, undo };

    /** Switch views, carrying the selection across. */
    const show = (next: Mode, from?: number, to?: number) => {
      if (!visual) return;
      if (next === 'source') {
        const sel = visual.editor.state.selection;
        const [a, b] = [from ?? sel.from, to ?? sel.to];
        const anchor = visual.toSource(a, a === b ? -1 : 1);
        const head = visual.toSource(b, -1);
        // The source view must be on screen before it can scroll to the selection.
        flushSync(() => setMode('source'));
        view.requestMeasure();
        view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
        view.focus();
      } else {
        const sel = view.state.selection.main;
        flushSync(() => setMode('visual'));
        visual.select(sel.from, sel.to);
      }
    };
    switchTo.current = show;

    const setLocked = (on: boolean) => {
      view.dispatch({ effects: writable.reconfigure(lock(on || !canWrite)) });
      visual?.editor.setEditable(!on && canWrite);
    };
    // Typing into a file that is no longer served would go nowhere, so it stops.
    const refuse = () => {
      update({ refused: true });
      setLocked(true);
    };
    // "Apply my edits": connect again, and the held edits merge into the restored text.
    // "Discard my edits": a fresh page starts from the server's text, without the held edits.
    discardEdits.current = () => {
      discarding = true;
      location.reload();
    };
    keepEdits.current = () => {
      restoreSeen = restoreHeld;
      restoreHeld = null;
      update({ held: false });
      setLocked(false);
      reopen = true;
      socket.disconnect();
    };

    // Closing the tab with edits the server has not confirmed would lose them.
    let discarding = false;
    const warn = (e: BeforeUnloadEvent) => {
      if (provider.hasUnsyncedChanges && !discarding) e.preventDefault();
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
      visual?.destroy();
      view.destroy();
      undo.destroy();
      provider.destroy();
      doc.destroy();
    };
    // The editor is rebuilt only when a different file is opened.
  }, [projectId, fileId, canWrite, user, syncUrl, props.path, props.visual, sourceOnly]);

  const waiting = `${sync.unsynced} edit${sync.unsynced === 1 ? '' : 's'}`;
  const status = sync.refused
    ? 'You no longer have access to this file, or it has been deleted.'
    : sync.held
      ? `This paper was restored to an earlier revision while you were offline. Your ${waiting} from before that ${sync.unsynced === 1 ? 'is' : 'are'} not saved.`
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
        {sync.held && (
          <span role="group" aria-label="Your unsaved edits">
            <button type="button" onClick={() => keepEdits.current()}>
              Apply my edits to the restored paper
            </button>
            <button type="button" onClick={() => discardEdits.current()}>
              Discard my edits
            </button>
          </span>
        )}
        <span>
          {others.length ? `Also here: ${[...new Set(others)].join(', ')}` : 'Nobody else is here.'}
        </span>
      </div>
      {props.visual && (
        <div className="toolbar">
          <span role="group" aria-label="View">
            {(['visual', 'source'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => mode !== m && switchTo.current(m)}
              >
                {m === 'visual' ? 'Visual' : 'Source'}
              </button>
            ))}
          </span>
          {mode === 'visual' && canWrite && !sync.refused && (
            <span role="group" aria-label="Edit">
              <button type="button" onClick={() => live.current?.visual?.emph()}>
                Emphasise
              </button>
              <button type="button" onClick={() => live.current?.undo.undo()}>
                Undo
              </button>
              <button type="button" onClick={() => live.current?.undo.redo()}>
                Redo
              </button>
            </span>
          )}
          <span className="note" aria-live="polite">
            {note}
          </span>
        </div>
      )}
      <div className="visual" ref={visualHost} hidden={mode !== 'visual'} />
      <div className="source" ref={host} hidden={mode !== 'source'} />
    </section>
  );
}
