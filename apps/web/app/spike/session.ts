// Two authors editing one file, each with a source editor and a visual editor, joined by a relay
// that can be slowed down or cut. This is the Phase B harness; the real sync server replaces the
// relay.
import { defaultKeymap } from '@codemirror/commands';
import { EditorState as CMState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { Bridge, extensions, fromSrc, toSrc } from '@paperweave/bridge';
import { Editor, Extension, type Node } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import katex from 'katex';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';

export type Status = { pending: number; message: string };

const ENV = /^\\begin\{(\w+)\*?\}([\s\S]*)\\end\{\1\*?\}$/;
const MULTILINE = new Set(['align', 'gather', 'multline', 'eqnarray', 'flalign', 'alignat']);

/** LaTeX maths source as KaTeX wants it: no delimiters, no labels. */
function tex(src: string) {
  const env = ENV.exec(src);
  if (env) {
    const inner = env[2].replace(/\\label\{[^}]*\}/g, '');
    return MULTILINE.has(env[1]) ? `\\begin{aligned}${inner}\\end{aligned}` : inner;
  }
  for (const [open, close] of [
    ['$$', '$$'],
    ['\\[', '\\]'],
    ['\\(', '\\)'],
    ['$', '$'],
  ])
    if (src.startsWith(open) && src.endsWith(close)) return src.slice(open.length, -close.length);
  return src;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

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

  // eslint-disable-next-line prefer-const -- the editor's plugins need the bridge, which needs the editor's schema
  let bridge: Bridge;
  const showInSource = (from: number, to = from) => {
    const at = (pos: number, side: -1 | 1) => toSrc(bridge.model, editor.state.doc, pos, side);
    cm.dispatch({
      selection: { anchor: at(from, from === to ? -1 : 1), head: at(to, -1) },
      scrollIntoView: true,
    });
    cm.focus();
  };
  const emph = () => {
    const c = bridge.emphCommand(editor.state);
    const result = c ? bridge.applyCommand(c) : 'rejected';
    if (result !== 'applied') say(`${name}: emphasis needs a selection inside one block.`);
    return true;
  };

  const math = (display: boolean) => (node: PMNode) => {
    const dom = el(display ? 'div' : 'span', `pw-atom pw-math${display ? ' pw-block' : ''}`);
    try {
      katex.render(tex(node.attrs.src), dom, { displayMode: display, throwOnError: true });
    } catch {
      // Project macros are unknown to the in-browser renderer: show the source as it is.
      dom.textContent = node.attrs.src;
      dom.classList.add('pw-raw');
    }
    dom.title = node.attrs.src;
    return { dom };
  };
  const chip = (label: (src: string) => string) => (node: PMNode) => {
    const dom = el('span', `pw-atom pw-${node.type.name}`, label(node.attrs.src));
    dom.title = node.attrs.src;
    return { dom };
  };
  const block = (node: PMNode, getPos: () => number | undefined) => {
    const frozen = node.type.name === 'frozen';
    const dom = el('div', `pw-atom pw-block ${frozen ? 'pw-frozen' : 'pw-raw'}`);
    dom.setAttribute('role', 'group');
    const pos = getPos() ?? 0;
    if (frozen) {
      let order = 0;
      editor.state.doc.nodesBetween(0, pos, (n) => void (n.type.name === 'frozen' && order++));
      dom.append(el('strong', '', `Not valid LaTeX yet: ${node.attrs.message}.`));
      dom.append(el('p', 'pw-last', bridge.lastGood.get(order) || ''));
    } else dom.append(el('span', 'pw-label', `LaTeX: ${node.attrs.label}`));
    dom.append(el('pre', '', node.attrs.src));
    const go = el('button', '', frozen ? 'Fix in source' : 'Edit in source');
    go.type = 'button';
    go.onclick = () => showInSource(getPos() ?? 0);
    dom.append(go);
    return { dom };
  };

  const views: Record<
    string,
    (node: PMNode, getPos: () => number | undefined) => { dom: HTMLElement }
  > = {
    math_inline: math(false),
    math_block: math(true),
    raw_inline: chip((s) => (s.length > 28 ? s.slice(0, 27) + '…' : s)),
    cite: chip((s) => `[${s.slice(s.lastIndexOf('{') + 1, -1)}]`),
    ref: chip((s) => `→${s.slice(s.lastIndexOf('{') + 1, -1)}`),
    raw_block: block,
    frozen: block,
  };
  const editor: Editor = new Editor({
    element: els.visual,
    enableInputRules: false,
    enablePasteRules: false,
    extensions: [
      ...extensions.map((ext) => {
        const view = views[ext.name];
        if (!view || ext.type !== 'node') return ext;
        return (ext as Node).extend({
          addNodeView: () => (p) => view(p.node, p.getPos as () => number | undefined),
        });
      }),
      Extension.create({
        name: 'bridge',
        addProseMirrorPlugins: () => [
          new Plugin({ filterTransaction: (tr, state) => !bridge || bridge.filter(tr, state) }),
        ],
        onTransaction: ({ transaction }) => bridge?.applied(transaction),
        addKeyboardShortcuts: () => ({
          'Mod-z': () => !!undo.undo() || true,
          'Mod-y': () => !!undo.redo() || true,
          'Mod-Shift-z': () => !!undo.redo() || true,
          'Mod-i': emph,
        }),
      }),
    ],
    editorProps: {
      attributes: {
        'aria-label': `${name}: visual editor`,
        role: 'textbox',
        'aria-multiline': 'true',
      },
    },
  });
  bridge = new Bridge(ytext, editor.schema, { sourceOnly });
  undo.addTrackedOrigin(bridge);
  bridge.onReject = () =>
    say(`${name}: that edit spans LaTeX structure. Make it in the source editor.`);
  bridge.attach({ getState: () => editor.state, dispatch: (tr) => editor.view.dispatch(tr) });
  bridge.sync();

  return {
    ydoc,
    ytext,
    cm,
    editor,
    bridge,
    undo,
    emph,
    src: () => ytext.toString(),
    showInSource: () => showInSource(editor.state.selection.from, editor.state.selection.to),
    showInVisual() {
      const { from, to } = cm.state.selection.main;
      const at = (off: number) => fromSrc(bridge.model, editor.state.doc, off);
      editor
        .chain()
        .focus()
        .setTextSelection({ from: at(from), to: at(to) })
        .scrollIntoView()
        .run();
    },
    destroy() {
      bridge.destroy();
      editor.destroy();
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
