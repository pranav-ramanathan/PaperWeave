// Two authors editing one file, each with a source editor and a visual editor, joined by a relay
// that can be slowed down or cut. This is the Phase B harness; the real sync server replaces the
// relay.
import { defaultKeymap } from '@codemirror/commands';
import { EditorState as CMState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { createVisual, type Visual } from '../../lib/visual';

export type Status = { pending: number; message: string };

function author(
  name: string,
  ydoc: Y.Doc,
  els: { source: HTMLElement; visual: HTMLElement },
  say: (message: string) => void,
  sourceOnly: boolean,
) {
  const ytext = ydoc.getText('source');
  // One undo stack per author, covering both of their editors and nobody else's edits.
  const undo = new Y.UndoManager(ytext);
  const cm = new EditorView({
    parent: els.source,
    state: CMState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': `${name}: LaTeX source` }),
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
        yCollab(ytext, null, { undoManager: undo }),
      ],
    }),
  });

  const showInSource = (from: number, to = from) => {
    cm.dispatch({
      selection: {
        anchor: visual.toSource(from, from === to ? -1 : 1),
        head: visual.toSource(to, -1),
      },
      scrollIntoView: true,
    });
    cm.focus();
  };
  const visual: Visual = createVisual({
    element: els.visual,
    ytext,
    undo,
    label: `${name}: visual editor`,
    sourceOnly,
    editable: true,
    say: (message) => say(`${name}: ${message}`),
    showInSource,
    // No server here: the command is checked against this author's own copy of the text.
    run: (c) => visual.bridge.applyCommand(c),
  });
  const { editor, bridge } = visual;

  return {
    ydoc,
    ytext,
    cm,
    editor,
    bridge,
    undo,
    emph: visual.emph,
    src: () => ytext.toString(),
    showInSource: () => showInSource(editor.state.selection.from, editor.state.selection.to),
    showInVisual() {
      const { from, to } = cm.state.selection.main;
      visual.select(from, to);
    },
    destroy() {
      visual.destroy();
      cm.destroy();
      undo.destroy();
    },
  };
}
export type Author = ReturnType<typeof author>;

export function createSession(
  els: Record<'A' | 'B', { source: HTMLElement; visual: HTMLElement }>,
  text: string,
  onStatus: (s: Status) => void,
  sourceOnly = false,
) {
  const docA = new Y.Doc();
  docA.getText('source').insert(0, text);
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

  const status: Status = { pending: 0, message: '' };
  const say = (message: string) => onStatus({ ...Object.assign(status, { message }) });
  const A = author('Author A', docA, els.A, say, sourceOnly);
  const B = author('Author B', docB, els.B, say, sourceOnly);

  const relay = { delay: 150, paused: false };
  const held: (() => void)[] = [];
  const count = (n: number) =>
    onStatus({ ...Object.assign(status, { pending: status.pending + n }) });
  const link = (from: Y.Doc, to: Y.Doc) =>
    from.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === relay) return;
      count(1);
      const deliver = () => {
        Y.applyUpdate(to, update, relay);
        count(-1);
      };
      const send = () => setTimeout(deliver, relay.delay);
      if (relay.paused) held.push(send);
      else send();
    });
  link(docA, docB);
  link(docB, docA);

  return {
    A,
    B,
    relay,
    setPaused(paused: boolean) {
      relay.paused = paused;
      if (!paused) for (const send of held.splice(0)) send();
    },
    destroy() {
      A.destroy();
      B.destroy();
    },
  };
}
export type Session = ReturnType<typeof createSession>;
