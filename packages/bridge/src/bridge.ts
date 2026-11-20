// Keeps one visual document in step with one shared LaTeX text.
import { DEFAULT_TRANSPARENT, parse, reparse, sourceOnly } from '@paperweave/latex';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { ReplaceStep } from '@tiptap/pm/transform';
import { type EditorState, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { locate, model, type Model, projector, toSrc } from './project.ts';
import { diff, type Edit, emphEdit, translate, type Translation } from './translate.ts';

export type Host = { getState(): EditorState; dispatch(tr: Transaction): void };

/** A structural edit: applied only if the text it was built against is still there. */
export type Command = {
  key: string;
  from: Y.RelativePosition;
  to: Y.RelativePosition;
  expected: string;
  replacement: string;
};
export type CommandResult = 'applied' | 'duplicate' | 'conflict';

export class Bridge {
  model: Model;
  /** What the visual editor last showed where a frozen block now is, by frozen-block order. */
  lastGood = new Map<number, string>();
  /** Called when an edit is refused because the visual editor cannot express it. */
  onReject: () => void = () => {};
  private host: Host | null = null;
  private pending = new WeakMap<Transaction, Translation>();
  private seen = new Set<string>();
  private observer = () => this.sync();
  private project: (m: Model) => PMNode;
  readonly ytext: Y.Text;

  /** True for a file that is shown but only edited in the source editor. */
  private whole: boolean;

  constructor(
    ytext: Y.Text,
    schema: Schema,
    opts: { transparent?: ReadonlySet<string>; sourceOnly?: boolean } = {},
  ) {
    this.ytext = ytext;
    this.project = projector(schema);
    this.whole = !!opts.sourceOnly;
    const src = ytext.toString();
    this.model = model(
      this.whole ? sourceOnly(src) : parse(src, opts.transparent ?? DEFAULT_TRANSPARENT),
    );
    ytext.observe(this.observer);
  }

  doc() {
    return this.project(this.model);
  }
  attach(host: Host) {
    this.host = host;
  }
  destroy() {
    this.ytext.unobserve(this.observer);
  }

  /** Decide whether a visual transaction may go ahead. Wire to filterTransaction. */
  filter = (tr: Transaction, state: EditorState): boolean => {
    if (!tr.docChanged || tr.getMeta('projection')) return true;
    const step = tr.steps.length === 1 ? tr.steps[0] : null;
    const plain = step instanceof ReplaceStep && !step.slice.openStart && !step.slice.openEnd;
    const hint = plain ? { from: step.from, to: step.to, size: step.slice.size } : undefined;
    const t = translate(this.model, state.doc, tr.doc, hint);
    if (!t) {
      // Backspace or Delete at an edge that cannot be joined, with nothing selected: nothing to say.
      const quiet = step instanceof ReplaceStep && step.slice.size === 0 && state.selection.empty;
      if (!quiet) this.onReject();
      return false;
    }
    this.pending.set(tr, t);
    return true;
  };

  /** Write an accepted transaction's edits to the shared text. Call after it is applied. */
  applied = (tr: Transaction) => {
    if (tr.getMeta('projection')) return;
    const t = this.pending.get(tr);
    // A just-opened empty paragraph lasts only while the caret is in it.
    let phantom = t ? t.phantom : this.model.phantom;
    const $head = tr.doc.resolve(tr.selection.head);
    if (phantom && ($head.depth !== 1 || $head.index(0) !== phantom.index)) phantom = null;
    const dropped = phantom !== this.model.phantom;
    this.model.phantom = phantom;
    if (t?.edits.length) this.splice(t.edits);
    else if (t || dropped) this.sync();
  };

  private splice(edits: Edit[]) {
    this.ytext.doc!.transact(() => {
      for (const e of [...edits].reverse()) {
        if (e.to > e.from) this.ytext.delete(e.from, e.to - e.from);
        if (e.insert) this.ytext.insert(e.from, e.insert);
      }
    }, this);
  }

  /** Bring the visual document in line with the shared text, touching only what differs. */
  sync() {
    const m = this.model;
    const old = m.parsed.src;
    const src = this.ytext.toString();
    const parsed = this.whole ? sourceOnly(src) : reparse(m.parsed, src);
    let phantom = m.phantom;
    if (phantom && src !== old) {
      let p = 0;
      while (p < old.length && old.charCodeAt(p) === src.charCodeAt(p)) p++;
      let s = 0;
      while (s < Math.min(old.length, src.length) - p && old.at(-1 - s) === src.at(-1 - s)) s++;
      const at = phantom.srcPos;
      // Text added exactly at the anchor grew the block before it, so the anchor moves along.
      if (old.length - s <= at) phantom = { ...phantom, srcPos: at + src.length - old.length };
      else if (p < at) phantom = null;
    }
    this.model = model(parsed, phantom);
    if (phantom) phantom.index = this.model.blocks.filter((b) => b.start < phantom.srcPos).length;
    if (!this.host) return;
    const state = this.host.getState();
    const next = this.project(this.model);
    const d = diff(state.doc, next);
    if (!d) return;

    let frozen = 0;
    next.forEach((n) => {
      if (n.type.name !== 'frozen') return;
      if (!this.lastGood.has(frozen))
        this.lastGood.set(frozen, state.doc.textBetween(d.a, d.endA, '\n\n', ' '));
      frozen++;
    });
    for (const k of this.lastGood.keys()) if (k >= frozen) this.lastGood.delete(k);

    const tr = state.tr;
    try {
      tr.step(new ReplaceStep(d.a, d.endA, next.slice(d.a, d.endB)));
    } catch {
      tr.replaceWith(0, state.doc.content.size, next.content);
    }
    // When everything is replaced (a file's text arriving, say) the selection is left on the
    // whole document, where the next key pressed would replace the file. Put the caret at the
    // first place text can go.
    if (d.a === 0 && d.endA === state.doc.content.size)
      tr.setSelection(Selection.findFrom(tr.doc.resolve(0), 1, true) ?? Selection.atStart(tr.doc));
    // The caret's text was taken away (its paragraph went): the selection would land on or beside
    // a block, where the next key is refused. Put it at the nearest place text can go.
    const was = state.selection;
    if (!(d.a === 0 && d.endA === state.doc.content.size) && was instanceof TextSelection) {
      const now = tr.selection;
      if (!(now instanceof TextSelection && now.$head.parent.inlineContent)) {
        const $at = tr.doc.resolve(
          Math.max(0, Math.min(tr.mapping.map(was.head, -1), tr.doc.content.size)),
        );
        const near = Selection.findFrom($at, -1, true) ?? Selection.findFrom($at, 1, true);
        if (near) tr.setSelection(near);
      }
    }
    this.host.dispatch(tr.setMeta('projection', true).setMeta('addToHistory', false));
  }

  /** Build the command that toggles emphasis on the selection, or null if it does not nest. */
  emphCommand(state: EditorState): Command | null {
    const { from, to } = state.selection;
    const x = locate(this.model, state.doc, from);
    const y = locate(this.model, state.doc, to);
    if (!x || !y || x.block < 0 || x.contentStart !== y.contentStart || from === to) return null;
    const e = emphEdit(x.text, x.pieces, x.off, y.off);
    if (!e) return null;
    const rel = (i: number) => Y.createRelativePositionFromTypeIndex(this.ytext, x.base + i);
    return {
      key: crypto.randomUUID(),
      from: rel(e.from),
      to: rel(e.to),
      expected: x.text.slice(e.from, e.to),
      replacement: e.insert,
    };
  }

  /**
   * Build the command that inserts LaTeX where the caret is (at the end of the selection, if
   * there is one), or null if the caret is not in running text. The place is fixed now: text
   * typed elsewhere before the command runs does not move it.
   */
  insertCommand(state: EditorState, replacement: string): Command | null {
    const spot = locate(this.model, state.doc, state.selection.to);
    // A paragraph just opened with Enter is not in the source yet: there is no place to name.
    if (!spot || spot.block < 0) return null;
    const at = Y.createRelativePositionFromTypeIndex(
      this.ytext,
      toSrc(this.model, state.doc, state.selection.to, -1),
    );
    return { key: crypto.randomUUID(), from: at, to: at, expected: '', replacement };
  }

  /**
   * Build the command that replaces the source of the atom at `pos` (a formula, a reference, a
   * block of raw LaTeX), or null if there is no atom there. With `part`, only that stretch of
   * the atom's source is replaced (one cell of a table, say), and only that stretch has to be
   * as it was: a change to another part of the same atom does not get in the way.
   */
  atomCommand(
    state: EditorState,
    pos: number,
    replacement: string,
    part?: { at: number; end: number },
  ): Command | null {
    const node = state.doc.nodeAt(pos);
    const src: unknown = node?.attrs.src;
    if (!node?.isAtom || typeof src !== 'string' || !src) return null;
    let from: number;
    if (node.isInline) from = toSrc(this.model, state.doc, pos, 1);
    else {
      // A block's text may carry the blank lines around the atom's own source.
      const i = state.doc.resolve(pos).index(0);
      const block =
        this.model.blocks[this.model.phantom && i > this.model.phantom.index ? i - 1 : i];
      const within = block ? block.body.text.indexOf(src) : -1;
      if (within < 0) return null;
      from = block.start + within;
    }
    // The model must agree with the text about where the atom is, or nothing is built.
    if (this.ytext.toString().slice(from, from + src.length) !== src) return null;
    const rel = (i: number) => Y.createRelativePositionFromTypeIndex(this.ytext, i);
    const [start, end] = part ? [part.at, part.end] : [0, src.length];
    if (start < 0 || end < start || end > src.length) return null;
    return {
      key: crypto.randomUUID(),
      from: rel(from + start),
      to: rel(from + end),
      expected: src.slice(start, end),
      replacement,
    };
  }

  /**
   * Apply a command against the text as it is now. Stands in for the server's command path.
   * shortcut: keeps keys in memory. The server's version (runCommand in packages/server) makes the
   * same comparison and stores keys durably.
   */
  applyCommand(c: Command): CommandResult {
    if (this.seen.has(c.key)) return 'duplicate';
    const doc = this.ytext.doc!;
    const from = Y.createAbsolutePositionFromRelativePosition(c.from, doc)?.index;
    const to = Y.createAbsolutePositionFromRelativePosition(c.to, doc)?.index;
    if (from == null || to == null || this.ytext.toString().slice(from, to) !== c.expected)
      return 'conflict';
    this.seen.add(c.key);
    this.splice([{ from, to, insert: c.replacement }]);
    return 'applied';
  }
}
