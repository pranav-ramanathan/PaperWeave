// The visual editor: a Tiptap view of one file's LaTeX text, kept in step by the bridge. Used by
// the app's file page and by the /spike harness.
import {
  Bridge,
  type Command,
  type CommandResult,
  extensions,
  fromSrc,
  toSrc,
} from '@paperweave/bridge';
import { Editor, Extension, type Node } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import katex from 'katex';
import * as Y from 'yjs';
import { numbers, onNumbers } from './numbers';

const ENV = /^\\begin\{(\w+)\*?\}([\s\S]*)\\end\{\1\*?\}$/;
const MULTILINE = new Set(['align', 'gather', 'multline', 'eqnarray', 'flalign', 'alignat']);

/** Environments the in-browser renderer can number row by row. */
const NUMBERED = new Set(['equation', 'align', 'gather', 'alignat']);
/** A number as LaTeX printed it, safe to put inside a `\\tag{}`. */
const tagged = (number: string | undefined) => (number ?? '??').replace(/[#$%&_{}~^\\]/g, '');

/**
 * LaTeX maths source as KaTeX wants it: no delimiters, no labels. With `numberOf`, each labelled
 * row carries the number LaTeX gave that label, the way the PDF shows it.
 */
function tex(src: string, numberOf?: (key: string) => string | undefined) {
  const env = ENV.exec(src);
  if (env) {
    if (numberOf && NUMBERED.has(env[1]) && env[2].includes('\\label{')) {
      const rows = env[2].replace(
        /\\label\{([^}]*)\}/g,
        (_, key: string) => `\\tag{${tagged(numberOf(key.trim()))}}`,
      );
      return `\\begin{${env[1]}*}${rows}\\end{${env[1]}*}`;
    }
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

/** Whether a formula's source is of the kind set on lines of its own. */
export const isDisplay = (src: string) => /^(\\begin\{|\\\[|\$\$)/.test(src.trim());

/**
 * Draw a formula into an element. `macros` are the paper's own; `numberOf` gives the number a
 * label has in the PDF. Throws what the renderer throws if the source cannot be drawn.
 */
export function renderMath(
  dom: HTMLElement,
  src: string,
  opts: { macros?: Record<string, string>; numberOf?: (key: string) => string | undefined } = {},
) {
  katex.render(tex(src.trim(), opts.numberOf), dom, {
    displayMode: isDisplay(src),
    throwOnError: true,
    // A copy: the renderer writes into what it is given.
    macros: { ...opts.macros },
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

export function createVisual(opts: {
  element: HTMLElement;
  ytext: Y.Text;
  /** The person's one undo history, shared with their source editor. */
  undo: Y.UndoManager;
  label: string;
  /** A file of definitions: shown, but edited in the source editor only. */
  sourceOnly: boolean;
  editable: boolean;
  say(message: string): void;
  /** Show a stretch of the visual document in the source editor. */
  showInSource(from: number, to: number): void;
  /** Carry out a structural edit. The app sends it to the server; the spike applies it locally. */
  run(command: Command): CommandResult | Promise<CommandResult>;
  /** The paper's own macros, for drawing formulas that use them. */
  macros?: Record<string, string>;
  /**
   * The person asked to edit a formula. `apply` replaces it with new LaTeX, by way of the
   * server, but only if it still says `src`: what someone else changed meanwhile is not
   * overwritten.
   */
  editMath?(src: string, apply: (replacement: string) => Promise<CommandResult>): void;
}) {
  const { undo, say } = opts;
  // eslint-disable-next-line prefer-const -- the editor's plugins need the bridge, which needs the editor's schema
  let bridge: Bridge;
  /** Open the formula at `pos` for editing. What it says now is what a later edit must find. */
  const openMath = (pos: number, src: string) => {
    const c = bridge.atomCommand(editor.state, pos, src);
    if (!c) return say('That formula cannot be edited here. Edit it in the source.');
    opts.editMath!(src, async (replacement) =>
      opts.run({ ...c, key: crypto.randomUUID(), replacement }),
    );
  };
  const emph = () => {
    const c = bridge.emphCommand(editor.state);
    if (!c) say('Emphasis needs a selection inside one block.');
    else
      Promise.resolve(opts.run(c)).then(
        (result) =>
          result === 'conflict' && say('That text changed before the edit arrived. Try again.'),
        () => say('That edit could not be made. Check the connection and try again.'),
      );
    return true;
  };

  /** Mark an element whose number comes from a PDF that is behind the text. */
  const age = (dom: HTMLElement, src: string) => {
    const n = numbers();
    dom.classList.toggle('pw-stale', n.known && n.stale);
    dom.title = !n.known
      ? src
      : `${src}\nNumbered as in the PDF${n.stale ? ', which is behind the text' : ''}.`;
  };
  const math = (display: boolean) => (node: PMNode, getPos: () => number | undefined) => {
    const src: string = node.attrs.src;
    const dom = el(display ? 'div' : 'span', `pw-atom pw-math${display ? ' pw-block' : ''}`);
    const labelled = display && src.includes('\\label{');
    const draw = () => {
      const n = numbers();
      const attempt = (numbered: boolean) =>
        renderMath(dom, src, {
          macros: opts.macros,
          numberOf: numbered ? (key) => n.labels[key]?.number : undefined,
        });
      dom.classList.remove('pw-raw');
      try {
        // With the numbers from the PDF if there are any; without, if that does not render.
        try {
          attempt(labelled && n.known);
        } catch {
          attempt(false);
        }
      } catch {
        // Something the in-browser renderer does not know: show the source as it is.
        dom.textContent = src;
        dom.classList.add('pw-raw');
      }
      if (labelled) age(dom, src);
      else dom.title = src;
    };
    draw();
    // A double click opens the formula's LaTeX for editing. So does Enter, when it is selected.
    if (opts.editMath && opts.editable) dom.ondblclick = () => openMath(getPos() ?? 0, src);
    return { dom, destroy: labelled ? onNumbers(draw) : undefined };
  };
  /** A reference shows the number its label has in the PDF, as the PDF prints it. */
  const ref = (node: PMNode) => {
    const src: string = node.attrs.src;
    const dom = el('span', 'pw-atom pw-ref');
    const m = /^\\(\w+)\*?(?:\[[^\]]*\])?\{([^}]*)\}/.exec(src);
    const keys = (m?.[2] ?? '').split(',').map((k) => k.trim());
    const draw = () => {
      const n = numbers();
      if (!n.known || !m) dom.textContent = `→${keys.join(', ')}`;
      else {
        // LaTeX prints ?? for a label it does not know. So do we.
        const page = m[1].toLowerCase().includes('pageref');
        const each = keys.map((k) => (page ? n.labels[k]?.page : n.labels[k]?.number) || '??');
        dom.textContent = m[1] === 'eqref' ? `(${each.join(', ')})` : each.join(', ');
        dom.classList.toggle('pw-unknown', each.includes('??'));
      }
      dom.setAttribute('aria-label', `reference to ${keys.join(', ')}: ${dom.textContent}`);
      age(dom, src);
    };
    draw();
    return { dom, destroy: onNumbers(draw) };
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
    go.onclick = () => opts.showInSource(getPos() ?? 0, getPos() ?? 0);
    dom.append(go);
    return { dom };
  };

  const views: Record<
    string,
    (node: PMNode, getPos: () => number | undefined) => { dom: HTMLElement; destroy?: () => void }
  > = {
    math_inline: math(false),
    math_block: math(true),
    raw_inline: chip((s) => (s.length > 28 ? s.slice(0, 27) + '…' : s)),
    cite: chip((s) => `[${s.slice(s.lastIndexOf('{') + 1, -1)}]`),
    ref,
    raw_block: block,
    frozen: block,
  };
  const editor: Editor = new Editor({
    element: opts.element,
    editable: opts.editable,
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
          // Enter on a selected formula opens it for editing.
          Enter: ({ editor: e }) => {
            const { selection } = e.state;
            const node = e.state.doc.nodeAt(selection.from);
            if (
              !opts.editMath ||
              !opts.editable ||
              selection.empty ||
              !node?.type.name.startsWith('math_')
            )
              return false;
            if (selection.to !== selection.from + node.nodeSize) return false;
            openMath(selection.from, node.attrs.src);
            return true;
          },
        }),
      }),
    ],
    editorProps: {
      attributes: { 'aria-label': opts.label, role: 'textbox', 'aria-multiline': 'true' },
    },
  });
  bridge = new Bridge(opts.ytext, editor.schema, { sourceOnly: opts.sourceOnly });
  undo.addTrackedOrigin(bridge);
  bridge.onReject = () => say('That edit spans LaTeX structure. Make it in the source editor.');
  bridge.attach({ getState: () => editor.state, dispatch: (tr) => editor.view.dispatch(tr) });
  bridge.sync();

  return {
    editor,
    bridge,
    emph,
    /** Where a place in the visual document is in the source text. */
    toSource: (pos: number, side: -1 | 1) => toSrc(bridge.model, editor.state.doc, pos, side),
    /** Select, in the visual document, the stretch between two places in the source text. */
    select(from: number, to: number) {
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
    },
  };
}
export type Visual = ReturnType<typeof createVisual>;
