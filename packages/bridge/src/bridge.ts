// Keeps one visual document in step with one shared LaTeX text.
import {
  contained,
  containedNear,
  DEFAULT_TRANSPARENT,
  HALF,
  inPair,
  parse,
  reparse,
  sourceOnly,
} from '@paperweave/latex';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { ReplaceStep } from '@tiptap/pm/transform';
import { type EditorState, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { needs, pasteable } from './clipboard.ts';
import { locate, model, type Model, projector, toSrc } from './project.ts';
import { diff, type Edit, emphEdit, guard, translate, type Translation } from './translate.ts';

export type Host = { getState(): EditorState; dispatch(tr: Transaction): void };

/** A structural edit: applied only if the text it was built against is still there. */
export type Command = {
  key: string;
  from: Y.RelativePosition;
  to: Y.RelativePosition;
  expected: string;
  replacement: string;
  /** The replacement of one inline atom: refused if it would spill into the text around it. */
  contained?: boolean;
  /**
   * With `contained`: the environments beyond the default that the paper's text counts as prose
   * (its own `\\newtheorem` names). The check reads the text around the atom with this set, as the
   * editor that built the command did.
   */
  prose?: string[];
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
  /** Set while a change that leaves a list is drawn: the caret goes to the phantom paragraph. */
  private leaving = false;
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
    // An edit that starts or ends between the halves of an emoji, or writes half of one, would
    // make the shared text turn the half into U+FFFD. The caret is never put there, so refuse.
    const src = this.model.parsed.src;
    if (t.edits.some((e) => inPair(src, e.from) || inPair(src, e.to) || HALF.test(e.insert))) {
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
    // A just-opened empty paragraph lasts only while the caret is in it.
    let phantom = t ? t.phantom : this.model.phantom;
    const $head = tr.doc.resolve(tr.selection.head);
    if (phantom && !t?.leave && ($head.depth !== 1 || $head.index(0) !== phantom.index))
      phantom = null;
    const dropped = phantom !== this.model.phantom;
    this.model.phantom = phantom;
    // Leaving a list: the caret was in the \item that is gone. The same transaction that draws
    // the change puts it in the paragraph after the list (see sync).
    this.leaving = !!t?.leave;
    try {
      if (t?.edits.length) this.splice(t.edits);
      else if (t || dropped) this.sync();
    } finally {
      this.leaving = false;
    }
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
    if (this.leaving && phantom) {
      let at = 0;
      for (let i = 0; i < phantom.index; i++) at += tr.doc.child(i).nodeSize;
      if (tr.doc.child(phantom.index).type.name === 'paragraph')
        tr.setSelection(TextSelection.create(tr.doc, at + 1));
    }
    this.host.dispatch(tr.setMeta('projection', true).setMeta('addToHistory', false));
  }

  /** Build the command that toggles emphasis on the selection, or null if it does not nest. */
  emphCommand(state: EditorState): Command | null {
    return this.markCommand(state, 'emph');
  }

  /** The same for \\textbf (or \\emph): a mark around the selection that is not it is left alone. */
  markCommand(state: EditorState, mark: 'emph' | 'textbf'): Command | null {
    const { from, to } = state.selection;
    const x = locate(this.model, state.doc, from);
    const y = locate(this.model, state.doc, to);
    if (!x || !y || x.block < 0 || x.contentStart !== y.contentStart || from === to) return null;
    const e = emphEdit(x.text, x.pieces, x.off, y.off, mark);
    // A selection can end between the halves of an emoji (the editor counts UTF-16 units); the
    // shared text would turn the cut half into U+FFFD on one replica only.
    const src = this.model.parsed.src;
    if (!e || inPair(src, x.base + e.from) || inPair(src, x.base + e.to)) return null;
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
   * The source text of the selection, exactly as written, or null if it cannot travel on its own:
   * nothing is selected, an end is not in running text, an end splits a group (half of an
   * `\\emph`), or the stretch would not stand alone (see pasteable). Paragraph breaks and
   * whole blocks between the ends come as they are in the source.
   */
  sourceOf(state: EditorState): string | null {
    const { from, to } = state.selection;
    if (from === to) return null;
    const x = locate(this.model, state.doc, from);
    const y = locate(this.model, state.doc, to);
    const src = this.ytext.toString();
    if (!x || !y || x.block < 0 || y.block < x.block || src !== this.model.parsed.src) return null;
    const a = toSrc(this.model, state.doc, from, 1);
    const b = toSrc(this.model, state.doc, to, -1);
    if (b <= a || inPair(src, a) || inPair(src, b)) return null;
    // Every group opened inside the stretch is closed inside it, and the other way round.
    let depth = 0;
    for (let k = x.block; k <= y.block; k++) {
      const { start, body } = this.model.blocks[k];
      const runs =
        body.kind === 'list'
          ? body.items.map((it) => it.pieces)
          : 'pieces' in body
            ? [body.pieces]
            : [];
      for (const pieces of runs)
        for (const p of pieces) {
          if (start + p.s < a || start + p.e > b) continue;
          if (p.k === 'open') depth++;
          else if (p.k === 'close' && --depth < 0) return null;
        }
    }
    const latex = src.slice(a, b);
    return depth === 0 && pasteable(latex) ? latex : null;
  }

  /**
   * What kind of block the caret is at the top level of: 'para' (an ordinary paragraph), 'item'
   * (a list item), or null if it is inside a group (`\\emph{...}`), in a heading, caption or raw
   * block, not in running text, or in a paragraph not yet in the source. Block-level LaTeX (a
   * blank line, a heading, a list, an `\\item`) can only be put where this is not null.
   */
  blockPlace(state: EditorState): 'para' | 'item' | null {
    const spot = locate(this.model, state.doc, state.selection.to);
    if (!spot || spot.block < 0) return null;
    const kind = this.model.blocks[spot.block].body.kind;
    if (kind !== 'para' && kind !== 'list') return null;
    const i = toSrc(this.model, state.doc, state.selection.to, -1) - spot.base;
    let depth = 0;
    for (const p of spot.pieces) {
      if (p.e > i) break;
      if (p.k === 'open') depth++;
      else if (p.k === 'close') depth--;
    }
    if (depth !== 0) return null;
    return kind === 'list' ? 'item' : 'para';
  }

  /** Whether `latex` (copied from a paper) can go where the caret is as LaTeX (see needs). */
  accepts(state: EditorState, latex: string): boolean {
    const need = needs(latex);
    const place = this.blockPlace(state);
    return need === 'item' ? place === 'item' : need === 'block' ? place !== null : true;
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
    const i = toSrc(this.model, state.doc, state.selection.to, -1);
    if (inPair(this.model.parsed.src, i)) return null;
    // One anchor on each side of the caret, so that if the text around it is deleted the
    // command can tell (see placeLost in packages/server). `to` is also where the caret goes
    // afterwards: it stands on the character after, which ends up after the insertion.
    return {
      key: crypto.randomUUID(),
      from: Y.createRelativePositionFromTypeIndex(this.ytext, i, -1),
      to: Y.createRelativePositionFromTypeIndex(this.ytext, i),
      expected: '',
      replacement,
    };
  }

  /**
   * `c` (from insertCommand) with `latex` as its replacement, guarded as typed text is: `{}` before
   * it where it would join a command name or become the argument of one (`[`, `*`), `{}` after it
   * where the text that follows would, and a line break before it where the place is in a comment.
   * Built against the text as it is now.
   */
  fillCommand(c: Command, latex: string): Command {
    const at = Y.createAbsolutePositionFromRelativePosition(c.to, this.ytext.doc!)?.index;
    if (at == null || !latex) return { ...c, replacement: latex };
    const src = this.ytext.toString();
    const lead = guard(src.slice(0, at), latex);
    const trail = guard(src.slice(0, at) + lead + latex, src[at] ?? '');
    return { ...c, replacement: lead + latex + trail };
  }

  /**
   * How many line breaks (0 to 2) a block put at `i` still needs before and after it to be
   * set apart by blank lines. Blank lines already there count: at the start or the end of a
   * paragraph they usually are; the start of the file needs none.
   */
  private padding(src: string, i: number): [number, number] {
    let before = 0;
    while (before < 2 && src[i - 1 - before] === '\n') before++;
    let after = 0;
    while (after < 2 && src[i + after] === '\n') after++;
    if (i === 0) before = 2;
    return [2 - before, 2 - after];
  }

  /**
   * Build the command that inserts a sectioning command, with `title` as its argument, where the
   * caret is, or null if the caret is not in an ordinary paragraph (a list item, a heading, a
   * caption or other raw LaTeX, the preamble and a paragraph not yet in the source are all
   * refused). The paragraph is split there. Only as many line breaks are added as are needed to
   * give the heading blank lines on both sides, so no run of three is ever made. `title` must be
   * valid as the argument of a command: the caller checks it.
   */
  headingCommand(
    state: EditorState,
    level: 'section' | 'subsection' | 'subsubsection',
    title: string,
  ): Command | null {
    if (this.blockPlace(state) !== 'para') return null;
    const src = this.model.parsed.src;
    const i = toSrc(this.model, state.doc, state.selection.to, -1);
    const [before, after] = this.padding(src, i);
    const latex = '\n'.repeat(before) + `\\${level}{${title}}` + '\n'.repeat(after);
    return this.insertCommand(state, latex);
  }

  /**
   * Build the command that inserts an empty bulleted (or, `ordered`, numbered) list of one item
   * where the caret is, or null where headingCommand refuses (only an ordinary paragraph takes
   * one). It is put in blank lines on both sides as a heading is. The caller puts the caret
   * after `\item `, inside the empty item.
   */
  listCommand(state: EditorState, ordered: boolean): Command | null {
    if (this.blockPlace(state) !== 'para') return null;
    const i = toSrc(this.model, state.doc, state.selection.to, -1);
    const [before, after] = this.padding(this.model.parsed.src, i);
    const env = ordered ? 'enumerate' : 'itemize';
    const latex =
      '\n'.repeat(before) + `\\begin{${env}}\n\\item \n\\end{${env}}` + '\n'.repeat(after);
    return this.insertCommand(state, latex);
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
    const [start, end] = part ? [part.at, part.end] : [0, src.length];
    if (start < 0 || end < start || end > src.length) return null;
    // An empty part is an insertion: its `from` holds the character before, as insertCommand's does.
    const rel = (i: number, assoc = 0) =>
      Y.createRelativePositionFromTypeIndex(this.ytext, i, assoc);
    return {
      key: crypto.randomUUID(),
      from: rel(from + start, start === end ? -1 : 0),
      to: rel(from + end),
      expected: src.slice(start, end),
      replacement,
    };
  }

  /**
   * Put `replacement` in place of what the command names, an inline atom, if the text around it
   * would still be read as it was: nothing outside it changes, and what it is replaced with
   * stays in the same paragraph or list item. 'spills' if not; 'conflict' if the atom's text
   * has changed since the command was built.
   */
  rewriteCommand(c: Command, replacement: string): Command | 'conflict' | 'spills' {
    const doc = this.ytext.doc!;
    const from = Y.createAbsolutePositionFromRelativePosition(c.from, doc)?.index;
    const to = Y.createAbsolutePositionFromRelativePosition(c.to, doc)?.index;
    const src = this.model.parsed.src;
    if (
      from == null ||
      to == null ||
      src !== this.ytext.toString() ||
      src.slice(from, to) !== c.expected
    )
      return 'conflict';
    // Half of an emoji, before or after, cannot be put back as it was: the shared text would
    // turn it into U+FFFD.
    if (HALF.test(replacement) || HALF.test(src.slice(from, to))) return 'spills';
    const text = src.slice(0, from) + replacement + src.slice(to);
    const old = this.model.parsed;
    // The visual document is built from the incremental parse, so both it and a full parse must
    // agree that nothing around the atom moved.
    return contained(old, reparse(old, text), from, to - from, replacement.length) &&
      contained(old, parse(text, old.transparent), from, to - from, replacement.length)
      ? { ...c, key: crypto.randomUUID(), replacement, contained: true, ...this.proseOf() }
      : 'spills';
  }

  /** The model's own transparent names beyond the default, for a command to carry. */
  private proseOf(): { prose?: string[] } {
    const extra = [...this.model.parsed.transparent].filter((n) => !DEFAULT_TRANSPARENT.has(n));
    return extra.length ? { prose: extra.sort() } : {};
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
    // Never cut an emoji in two: the shared text would turn the half into U+FFFD for others.
    const now = this.ytext.toString();
    if (inPair(now, from) || inPair(now, to) || HALF.test(c.replacement)) return 'conflict';
    // shortcut: a local copy of placeLost (packages/server/src/commands.ts), which this package
    // cannot import without a circular dependency. Same rule: an insertion is refused if the
    // character either anchor holds on to is deleted. No anchor item (file start or end) is never lost.
    if (c.expected === '') {
      const deleted = Y.createDeleteSetFromStructStore(doc.store);
      for (const a of [c.from, c.to]) {
        const item = a.item;
        if (item !== null && Y.isDeleted(deleted, item)) return 'conflict';
      }
    }
    // shortcut: same check as runCommand's, with the set the model holds.
    if (
      c.contained &&
      !containedNear(
        this.ytext.toString(),
        from,
        to - from,
        c.replacement,
        this.model.parsed.transparent,
      )
    )
      return 'conflict';
    this.seen.add(c.key);
    this.splice([{ from, to, insert: c.replacement }]);
    return 'applied';
  }
}
