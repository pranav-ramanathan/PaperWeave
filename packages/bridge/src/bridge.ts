// Keeps one visual document in step with one shared LaTeX text.
import { DEFAULT_TRANSPARENT, parse, reparse } from '@paperweave/latex';
import { ReplaceStep } from '@tiptap/pm/transform';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { locate, model, type Model, project } from './project.ts';
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
  readonly ytext: Y.Text;

  constructor(ytext: Y.Text, transparent: ReadonlySet<string> = DEFAULT_TRANSPARENT) {
    this.ytext = ytext;
    this.model = model(parse(ytext.toString(), transparent));
    ytext.observe(this.observer);
  }

  doc() {
    return project(this.model);
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
    const t = translate(this.model, state.doc, tr.doc);
    if (!t) {
      this.onReject();
      return false;
    }
    this.pending.set(tr, t);
    return true;
  };

  /** Write an accepted transaction's edits to the shared text. Call after it is applied. */
  applied = (tr: Transaction) => {
    if (tr.getMeta('projection')) return;
    const t = this.pending.get(tr);
    if (!t) {
      // Leaving a still-empty new paragraph removes it.
      const ph = this.model.phantom;
      if (ph && locate(this.model, tr.doc, tr.selection.head)?.block !== -1) {
        this.model.phantom = null;
        this.sync();
      }
      return;
    }
    this.model.phantom = t.phantom;
    if (t.edits.length) this.splice(t.edits);
    else this.sync();
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
    const parsed = reparse(m.parsed, src);
    let phantom = m.phantom;
    if (phantom && src !== old) {
      let p = 0;
      while (p < old.length && old.charCodeAt(p) === src.charCodeAt(p)) p++;
      let s = 0;
      while (s < Math.min(old.length, src.length) - p && old.at(-1 - s) === src.at(-1 - s)) s++;
      const at = phantom.srcPos;
      if (old.length - s <= at && p < at)
        phantom = { ...phantom, srcPos: at + src.length - old.length };
      else if (p < at) phantom = null;
    }
    this.model = model(parsed, phantom);
    if (phantom) phantom.index = this.model.blocks.filter((b) => b.start < phantom.srcPos).length;
    if (!this.host) return;
    const state = this.host.getState();
    const next = project(this.model);
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
   * Apply a command against the text as it is now. Stands in for the server's command path.
   * shortcut: compares the expected text itself and keeps keys in memory; the server version
   * (plan C6) compares a SHA-256 and stores keys durably.
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
