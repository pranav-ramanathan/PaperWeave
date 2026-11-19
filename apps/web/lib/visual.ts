// The visual editor: a Tiptap view of one file's LaTeX text, kept in step by the bridge. Used by
// the app's file page and by the /spike harness.
import {
  Bridge,
  type Command,
  type CommandResult,
  escape,
  extensions,
  fromSrc,
  toSrc,
} from '@paperweave/bridge';
import {
  altEdit,
  cellText,
  floatParts,
  type Span,
  tableEdit,
  type TableOp,
} from '@paperweave/latex';
import { Editor, Extension, type Node } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import katex from 'katex';
import * as Y from 'yjs';
import { bibliography, onBibliography } from './bibliography';
import { pageNonce } from './nonce';
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
  /** The address of a picture, given the name an \\includegraphics uses for it. */
  picture?(target: string): string;
  /**
   * The person asked to edit a formula. `apply` replaces it with new LaTeX, by way of the
   * server, but only if it still says `src`: what someone else changed meanwhile is not
   * overwritten.
   */
  editMath?(src: string, apply: (replacement: string) => Promise<CommandResult>): void;
  /** The person asked, from the keyboard, to insert a reference, a citation or an equation. */
  ask?(what: 'reference' | 'citation' | 'equation' | 'figure' | 'table'): void;
  /**
   * The person asked for the menu of things to do here: a right click, or the menu key. `x`
   * and `y` are where on the page; `formula` is set when it was asked for on a formula.
   */
  menu?(at: { x: number; y: number; formula?: () => void }): void;
}) {
  const { undo, say } = opts;
  // eslint-disable-next-line prefer-const -- the editor's plugins need the bridge, which needs the editor's schema
  let bridge: Bridge;
  /**
   * Put the caret, or a selection, at a place in the document. Between two blocks no text can
   * go: just after an equation on a line of its own, say. Asked for such a place, this takes
   * the nearest one after it that can take text, or failing that the nearest before it. (A
   * caret left between blocks is not drawn, and what is typed next lands before the equation.)
   */
  const selectAt = (from: number, to = from) => {
    const { doc, tr } = editor.state;
    const at = (pos: number) => doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    editor.view.dispatch(tr.setSelection(TextSelection.between(at(from), at(to), 1)));
  };
  /**
   * Bring the editor's idea of the selection up to date with the browser's. The editor hears of
   * a moved caret a moment after it moves; a shortcut pressed in that moment would otherwise
   * act where the caret was.
   */
  const catchUp = () => {
    const { view } = editor;
    const sel = view.dom.ownerDocument.getSelection();
    // Not only while the editor has the keyboard: pressing a toolbar button takes the keyboard
    // away, and the selection it should act on is still the one in the text.
    if (!sel?.anchorNode || !sel.focusNode) return;
    if (!view.dom.contains(sel.anchorNode) || !view.dom.contains(sel.focusNode)) return;
    try {
      const a = view.posAtDOM(sel.anchorNode, sel.anchorOffset);
      const b = view.posAtDOM(sel.focusNode, sel.focusOffset);
      const { from, to } = editor.state.selection;
      if (Math.min(a, b) !== from || Math.max(a, b) !== to)
        editor.commands.setTextSelection({ from: Math.min(a, b), to: Math.max(a, b) });
    } catch {
      // A selection the editor cannot place (inside a drawn formula, say): leave its own.
    }
  };
  /**
   * Where the caret should be when the keyboard comes back from a window opened here. The
   * browser, handing focus back, may put it at the start of the text.
   */
  let resume: { from: number; to: number } | null = null;
  /** Open the formula at `pos` for editing. What it says now is what a later edit must find. */
  const openMath = (pos: number, src: string) => {
    const c = bridge.atomCommand(editor.state, pos, src);
    if (!c) return say('That formula cannot be edited here. Edit it in the source.');
    resume = { from: editor.state.selection.from, to: editor.state.selection.to };
    opts.editMath!(src, async (replacement) =>
      opts.run({ ...c, key: crypto.randomUUID(), replacement }),
    );
  };
  const emph = () => {
    catchUp();
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
  /** A citation shows its keys, says on hover what they cite, and is marked if one has no entry. */
  const cite = (node: PMNode) => {
    const src: string = node.attrs.src;
    const dom = el('span', 'pw-atom pw-cite');
    const keys = src
      .slice(src.lastIndexOf('{') + 1, -1)
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    dom.textContent = `[${keys.join(', ')}]`;
    const draw = () => {
      const b = bibliography();
      const missing = b.known ? keys.filter((k) => !(k in b.entries)) : [];
      dom.classList.toggle('pw-unknown', missing.length > 0);
      const said = keys.map((k) => b.entries[k] ?? (b.known ? `${k}: not in the bibliography` : k));
      dom.title = `${src}\n${said.join('\n')}`;
      dom.setAttribute('aria-label', `citation: ${said.join('; ')}`);
    };
    draw();
    return { dom, destroy: onBibliography(draw) };
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
  /** Text as it reads, for showing: `100\\%` as 100%. What is edited is always the LaTeX itself. */
  const shown = (latex: string) => latex.replace(/\\([%&_#$])/g, '$1');
  /**
   * One part of a figure or table that is edited where it stands: a cell, a caption. Pressing
   * it turns it into a field holding its LaTeX; Enter puts the new text in its place, by way of
   * the server, and only if the part still says what it said. Escape leaves it alone.
   */
  const part = (
    getPos: () => number | undefined,
    span: Span,
    name: string,
    allowed: (text: string) => string | null = () => null,
    /** Told which field is open, or null when none is, so that its owner can speak for it. */
    opened: (field: HTMLInputElement | null) => void = () => {},
    /**
     * For a part that may not be there yet (a picture's description): what to show in its
     * place, and how typed text becomes a change to the source, or a reason it cannot.
     */
    absent?: {
      prompt: string;
      edit(text: string): { at: number; end: number; insert: string } | string;
    },
  ) => {
    const empty = absent?.prompt ?? '\u00a0';
    if (!opts.editable) return el('span', 'pw-part', shown(span.text) || (absent ? 'None.' : ''));
    const button = el('button', 'pw-part', shown(span.text) || empty);
    button.type = 'button';
    button.classList.toggle('pw-missing', !!absent && !span.text);
    button.setAttribute('aria-label', `${name}: ${shown(span.text) || 'none'}. Edit`);
    button.onclick = () => {
      const pos = getPos() ?? 0;
      const input = el('input', 'pw-part');
      input.value = input.defaultValue = span.text;
      input.spellcheck = false;
      input.setAttribute('aria-label', name);
      input.size = Math.max(4, span.text.length + 2);
      let over = false;
      const leave = () => {
        over = true;
        opened(null);
        if (input.isConnected) input.replaceWith(button);
      };
      const apply = async () => {
        const text = input.value.trim();
        if (text === span.text) return leave();
        const problem = allowed(text);
        if (problem) return say(problem);
        const change = absent ? absent.edit(text) : { ...span, insert: text };
        if (typeof change === 'string') return say(change);
        const c = bridge.atomCommand(editor.state, pos, change.insert, change);
        if (!c) return say('That has moved. Edit it in the source.');
        over = true;
        // From here the field is no longer something being typed in: when the figure or table
        // is drawn again because this very edit went through, there is nothing to warn about.
        opened(null);
        try {
          const result = await opts.run(c);
          if (result === 'conflict')
            say('Someone changed that while you were editing it. Look again, then try again.');
        } catch {
          say('That edit could not be made. Check the connection and try again.');
        }
        // Applied, the figure or table is drawn again from the new source; if not, as it was.
        leave();
        editor.commands.setNodeSelection(Math.min(pos, editor.state.doc.content.size - 1));
        editor.view.focus();
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') void apply();
        else if (e.key === 'Escape') {
          leave();
          button.focus();
        }
      };
      input.onblur = () => !over && leave();
      button.replaceWith(input);
      opened(input);
      input.focus();
      input.select();
    };
    return button;
  };

  const block = (node: PMNode, getPos: () => number | undefined) => {
    const frozen = node.type.name === 'frozen';
    const float = frozen ? null : floatParts(node.attrs.src);
    // A simple table is drawn as a grid, and its cells and caption are edited in place. So is
    // a figure's caption. Anything else of theirs is edited in the source.
    const grid = float?.table?.simple ? float.table : null;
    if (float && (grid || float.caption || float.graphics.length)) {
      /** The field open in this figure or table, if one is. */
      let field: HTMLInputElement | null = null;
      const opened = (f: HTMLInputElement | null) => void (field = f);
      const dom = el('div', `pw-atom pw-block pw-float pw-${float.kind}`);
      dom.setAttribute('role', 'group');
      dom.setAttribute('aria-label', float.kind === 'table' ? 'Table' : 'Figure');
      const caption = float.caption
        ? [
            el('span', 'pw-label', float.kind === 'table' ? 'Table: ' : 'Figure: '),
            part(getPos, float.caption, 'Caption', undefined, opened),
          ]
        : [];
      /**
       * A button that adds or removes a row or a column, or nothing if that cannot be done to
       * this table. The change is made by the server, to the table as it is now.
       */
      const reshape = (op: TableOp, sign: string, name: string) => {
        const e = opts.editable && grid ? tableEdit(node.attrs.src, grid, op) : null;
        if (!e) return [];
        const button = el('button', 'pw-op', sign);
        button.type = 'button';
        button.setAttribute('aria-label', name);
        button.title = name;
        button.onclick = async () => {
          const pos = getPos() ?? 0;
          const c = bridge.atomCommand(editor.state, pos, e.insert, {
            at: e.at,
            end: e.at + e.length,
          });
          if (!c) return say('That has moved. Edit it in the source.');
          try {
            if ((await opts.run(c)) === 'conflict')
              say(
                'Someone changed this table while you were changing it. Look again, then try again.',
              );
          } catch {
            say('That edit could not be made. Check the connection and try again.');
          }
          editor.commands.setNodeSelection(Math.min(pos, editor.state.doc.content.size - 1));
          editor.view.focus();
        };
        return [button];
      };
      if (grid) {
        const table = el('table', '');
        if (caption.length) {
          const c = el('caption', '');
          c.append(...caption);
          table.append(c);
        }
        const body = el('tbody', '');
        grid.rows.forEach((row, i) => {
          const tr = el('tr', '');
          row.forEach((cell, j) => {
            const td = el(i === 0 ? 'th' : 'td', '');
            if (i === 0) td.setAttribute('scope', 'col');
            td.append(
              part(
                getPos,
                cell,
                `Row ${i + 1}, column ${j + 1}`,
                (text) =>
                  cellText(text)
                    ? null
                    : 'A cell cannot hold an unescaped &, a row break or a %. Edit the table in the source for that.',
                opened,
              ),
            );
            tr.append(td);
          });
          const ops = el('td', 'pw-ops');
          ops.append(
            ...reshape({ kind: 'row-after', row: i }, '+', `Add a row below row ${i + 1}`),
            ...reshape({ kind: 'row-delete', row: i }, '−', `Delete row ${i + 1}`),
          );
          if (ops.childElementCount) tr.append(ops);
          body.append(tr);
        });
        table.append(body);
        // Under each column, the buttons that add a column after it or take it away.
        const foot = el('tr', '');
        grid.rows[0].forEach((_, j) => {
          const ops = el('td', 'pw-ops');
          ops.append(
            ...reshape(
              { kind: 'column-after', column: j },
              '+',
              `Add a column after column ${j + 1}`,
            ),
            ...reshape({ kind: 'column-delete', column: j }, '−', `Delete column ${j + 1}`),
          );
          foot.append(ops);
        });
        if (foot.querySelector('button')) {
          const tfoot = el('tfoot', '');
          tfoot.append(foot);
          table.append(tfoot);
        }
        dom.append(table);
      } else {
        for (const g of float.graphics) {
          const file = g.target.text;
          const unseen = () =>
            el('p', 'pw-label', `${file} cannot be shown here. It is in the PDF.`);
          if (opts.picture) {
            const img = el('img', '');
            // Fetched when it is scrolled near, not when the file opens: a results section of
            // sixty figures was sixty requests and 12 MB before a word could be read.
            img.loading = 'lazy';
            img.src = opts.picture(file);
            img.alt = g.alt?.text ?? '';
            // A PDF or EPS figure, or a file that is not there.
            img.onerror = () => img.replaceWith(unseen());
            dom.append(img);
          } else dom.append(unseen());
          // What a screen reader says in place of the picture. Missing, it is shown as missing.
          const said = el('p', 'pw-describe');
          said.append(
            el('span', 'pw-label', 'Description, for people who cannot see it: '),
            part(
              getPos,
              g.alt ?? { text: '', at: 0, end: 0 },
              `Description of ${file}`,
              undefined,
              opened,
              {
                prompt: 'None yet. Add one.',
                edit(text) {
                  const e = altEdit(g, text);
                  if (!text.trim()) return 'Type a description, or press Escape.';
                  return e
                    ? { at: e.at, end: e.at + e.length, insert: e.insert }
                    : 'A description cannot hold { } % # ] or a backslash. Say it in plain words.';
                },
              },
            ),
          );
          dom.append(said);
        }
        if (!float.graphics.length) dom.append(el('p', 'pw-label', `LaTeX: ${node.attrs.label}`));
        const c = el('p', 'pw-caption');
        c.append(...caption);
        dom.append(c);
      }
      const go = el('button', '', 'Edit in source');
      go.type = 'button';
      go.onclick = () => opts.showInSource(getPos() ?? 0, getPos() ?? 0);
      dom.append(go);
      return {
        dom,
        // What happens inside (typing in a field, pressing a part) is ours, not the editor's.
        stopEvent: (e: Event) => e.target instanceof HTMLElement && dom.contains(e.target),
        ignoreMutation: () => true,
        // Drawn again because its source changed under an open field: what was being typed
        // would vanish without a word, so it is said, with the text.
        destroy() {
          if (field && field.value.trim() !== field.defaultValue)
            say(
              `Someone changed this ${float.kind} while you were editing it. Your text was not put in: ${field.value}`,
            );
        },
      };
    }
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
    (
      node: PMNode,
      getPos: () => number | undefined,
    ) => {
      dom: HTMLElement;
      destroy?: () => void;
      stopEvent?: (e: Event) => boolean;
      ignoreMutation?: () => boolean;
    }
  > = {
    math_inline: math(false),
    math_block: math(true),
    raw_inline: chip((s) => (s.length > 28 ? s.slice(0, 27) + '…' : s)),
    cite,
    ref,
    raw_block: block,
    frozen: block,
  };
  /** Stretches of the source to mark in the text: those with a thread of comments. */
  let marked: { from: number; to: number; kind: 'thread' | 'proposal' | 'finding' }[] = [];
  /**
   * Get ready to insert LaTeX where the caret is now. Returns the function that inserts it, by
   * way of the server, or null if the caret is not in running text.
   */
  const insertion = (): ((latex: string) => Promise<CommandResult>) | null => {
    catchUp();
    const c = bridge.insertCommand(editor.state, '');
    if (!c) return null;
    resume = { from: editor.state.selection.from, to: editor.state.selection.to };
    return async (latex) => {
      const result = await opts.run({ ...c, key: crypto.randomUUID(), replacement: latex });
      // The caret goes just after what was inserted, so that typing carries on from there
      // rather than over a selection that now reaches across it. The place was named by the
      // character after it, which is now the character after the insertion.
      const after = Y.createAbsolutePositionFromRelativePosition(c.to, opts.ytext.doc!)?.index;
      if (result !== 'conflict' && after != null) {
        const caret = fromSrc(bridge.model, editor.state.doc, after);
        selectAt(caret);
        const { from, to } = editor.state.selection;
        resume = { from, to };
      }
      return result;
    };
  };
  /**
   * Put text that was pasted or dropped where the caret is, as its words, as if typed: a
   * clipboard's formatting is not LaTeX. False if there was nothing to take.
   */
  const take = (text: string, files: number, verb = 'pasted'): boolean => {
    if (!opts.editable) return true;
    const { view } = editor;
    const act = verb === 'pasted' ? 'paste' : 'drop';
    if (!text.trim()) {
      if (!files) return false;
      say(
        `A picture or file cannot be ${verb} into the text. Add it to the paper on its page, then insert it as a figure.`,
      );
      return true;
    }
    const normal = text.replace(/\r\n?/g, '\n');
    const paragraphs = normal
      .split(/\n\s*\n/)
      .map((p) => p.replace(/[\t\n]+/g, ' ').trim())
      .filter(Boolean);
    if (paragraphs.length === 1) {
      // Kept as it was, spaces around it included, as the browser's own paste would.
      view.dispatch(view.state.tr.insertText(normal.replace(/[\t\n]+/g, ' ')).scrollIntoView());
      return true;
    }
    if (!view.state.selection.empty) {
      say(`Put the caret where the paragraphs should go, with nothing selected, then ${act}.`);
      return true;
    }
    const put = insertion();
    if (!put) {
      say(
        `Several paragraphs cannot be ${verb} here. ${act[0]!.toUpperCase() + act.slice(1)} them one at a time, or in the source.`,
      );
      return true;
    }
    void put(paragraphs.map(escape).join('\n\n')).then(
      (result) =>
        result === 'conflict' && say('That text changed before the edit arrived. Try again.'),
      () => say('That edit could not be made. Check the connection and try again.'),
    );
    return true;
  };
  const editor: Editor = new Editor({
    element: opts.element,
    injectNonce: pageNonce(),
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
          // The stretches of text that have a thread of comments, marked where they stand now.
          new Plugin({
            props: {
              decorations: (state) => {
                if (!bridge || !marked.length) return null;
                const size = state.doc.content.size;
                const at = (off: number) => Math.min(size, fromSrc(bridge.model, state.doc, off));
                return DecorationSet.create(
                  state.doc,
                  marked.flatMap((m) => {
                    const [from, to] = [at(m.from), at(m.to)];
                    return to > from
                      ? [Decoration.inline(from, to, { class: `${m.kind}-mark` })]
                      : [];
                  }),
                );
              },
            },
          }),
        ],
        onTransaction: ({ transaction }) => bridge?.applied(transaction),
        addKeyboardShortcuts: () => ({
          'Mod-z': () => !!undo.undo() || true,
          'Mod-y': () => !!undo.redo() || true,
          'Mod-Shift-z': () => !!undo.redo() || true,
          'Mod-i': emph,
          // Alt+= is the equation key in word processors; Alt+R for a reference.
          'Alt-=': () => (opts.ask && opts.editable ? (opts.ask('equation'), true) : false),
          'Alt-r': () => (opts.ask && opts.editable ? (opts.ask('reference'), true) : false),
          'Alt-c': () => (opts.ask && opts.editable ? (opts.ask('citation'), true) : false),
          'Alt-g': () => (opts.ask && opts.editable ? (opts.ask('figure'), true) : false),
          'Alt-t': () => (opts.ask && opts.editable ? (opts.ask('table'), true) : false),
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
      // What is pasted goes in as its words, as if typed: the clipboard's formatting is not LaTeX.
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        return take(data?.getData('text/plain') ?? '', data?.files.length ?? 0);
      },
      // What is dropped goes in as its words, where it is dropped, as pasted text does.
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false; // a drag within the text: as before
        const data = event.dataTransfer;
        const text = data?.getData('text/plain') ?? '';
        if (!text.trim() && !data?.files.length) return false;
        event.preventDefault();
        const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (hit) selectAt(hit.pos); // empty selection, so several paragraphs go in
        return take(text, data?.files.length ?? 0, 'dropped');
      },
    },
  });
  bridge = new Bridge(opts.ytext, editor.schema, { sourceOnly: opts.sourceOnly });
  undo.addTrackedOrigin(bridge);
  bridge.onReject = () => say('That edit spans LaTeX structure. Make it in the source editor.');
  bridge.attach({ getState: () => editor.state, dispatch: (tr) => editor.view.dispatch(tr) });
  bridge.sync();

  // Our own menu in place of the browser's, unless Shift is held: that one has copy, paste and
  // spelling, and stays one key away.
  const onMenu = (event: MouseEvent) => {
    if (!opts.menu || !opts.editable || event.shiftKey) return;
    event.preventDefault();
    // From the keyboard there is no pointer: the menu opens at the caret.
    const keyboard = event.button !== 2;
    const caret = editor.view.coordsAtPos(editor.state.selection.from);
    const at = keyboard
      ? { x: caret.left, y: caret.bottom }
      : { x: event.clientX, y: event.clientY };
    const hit = keyboard ? null : editor.view.posAtCoords({ left: at.x, top: at.y });
    // A click on a formula lands inside it (`inside`) or just beside it.
    const pos = hit ? (hit.inside >= 0 ? hit.inside : hit.pos) : editor.state.selection.from;
    const node = editor.state.doc.nodeAt(pos);
    const formula = node?.type.name.startsWith('math_')
      ? () => openMath(pos, node.attrs.src)
      : undefined;
    // The caret goes where the click was, so that what is inserted goes there too.
    if (hit && !formula) selectAt(hit.pos);
    opts.menu({ ...at, formula });
  };
  editor.view.dom.addEventListener('contextmenu', onMenu);

  // Tabbed into, the editor has the keyboard, but the browser may have nowhere to put a caret:
  // a file begins with its preamble, which is not text. The editor then assumes there is
  // nothing to do, and the arrow keys do nothing either. So the caret is put where the
  // editor's own selection is. Only when the keyboard brought the focus: a click puts the
  // caret where the click was, and must be left alone.
  let byPointer = false;
  const onPointer = () => {
    byPointer = true;
    setTimeout(() => (byPointer = false), 500);
  };
  editor.view.dom.addEventListener('pointerdown', onPointer, true);
  const onFocus = () => {
    if (byPointer) return;
    requestAnimationFrame(() => {
      if (byPointer || editor.isDestroyed || !editor.view.hasFocus()) return;
      const sel = editor.view.dom.ownerDocument.getSelection();
      if (sel?.anchorNode && editor.view.dom.contains(sel.anchorNode)) return;
      editor.view.focus();
    });
  };
  editor.view.dom.addEventListener('focus', onFocus);

  return {
    editor,
    bridge,
    emph,
    insertion,
    /** Put the keyboard back in the visual view, with the caret where it should be. */
    focus() {
      const { from, to } = resume ?? editor.state.selection;
      resume = null;
      editor.view.focus();
      selectAt(from, to);
    },
    /**
     * Take the selection as it is on the screen. The editor's own record of it can be a few
     * keys behind, and stops following once the keyboard has gone elsewhere.
     */
    catchUp,
    /** Mark these stretches of the source in the text. */
    setMarks(ranges: typeof marked) {
      marked = ranges;
      // Nothing changes but what is drawn.
      editor.view.dispatch(editor.state.tr.setMeta('marks', true));
    },
    /** Where a place in the visual document is in the source text. */
    toSource: (pos: number, side: -1 | 1) => toSrc(bridge.model, editor.state.doc, pos, side),
    /** Select, in the visual document, the stretch between two places in the source text. */
    select(from: number, to: number) {
      const at = (off: number) => fromSrc(bridge.model, editor.state.doc, off);
      editor.view.focus();
      selectAt(at(from), at(to));
      editor.view.dispatch(editor.state.tr.scrollIntoView());
    },
    destroy() {
      editor.view.dom.removeEventListener('contextmenu', onMenu);
      editor.view.dom.removeEventListener('focus', onFocus);
      editor.view.dom.removeEventListener('pointerdown', onPointer, true);
      bridge.destroy();
      editor.destroy();
    },
  };
}
export type Visual = ReturnType<typeof createVisual>;
