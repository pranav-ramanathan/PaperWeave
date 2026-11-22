// Headless replicas for tests: a shared text, a bridge and an editor state, with no browser.
import { decodeFile, parse, type Piece } from '@paperweave/latex';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';
import * as Y from 'yjs';
import { fixtureFiles, type Rng } from '../../latex/src/testutil.ts';
import { Bridge } from './bridge.ts';
import { locate, model, projector, width } from './project.ts';
import { schema } from './schema.ts';

const project = projector(schema);

export const fixtures = Object.fromEntries(
  Object.entries(fixtureFiles()).flatMap(([path, bytes]) => {
    const d = decodeFile(bytes);
    return d.editable && path.endsWith('.tex') && !path.startsWith('probes')
      ? [[path, d.text]]
      : [];
  }),
);

export function replica(
  text: string,
  from?: Y.Doc,
  opts: { transparent?: ReadonlySet<string> } = {},
) {
  const ydoc = new Y.Doc();
  if (from) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(from));
  const ytext = ydoc.getText('t');
  if (!from) ytext.insert(0, text);
  const bridge = new Bridge(ytext, schema, opts);
  let state = EditorState.create({ schema, doc: bridge.doc() });
  bridge.attach({ getState: () => state, dispatch: (tr) => void (state = state.apply(tr)) });
  return {
    ydoc,
    ytext,
    bridge,
    get state() {
      return state;
    },
    get src() {
      return ytext.toString();
    },
    /** What an editor view does with a transaction. Returns false if the bridge refused it. */
    dispatch(tr: Transaction) {
      if (!bridge.filter(tr, state)) return false;
      state = state.apply(tr);
      bridge.applied(tr);
      return true;
    },
    select(from: number, to = from) {
      this.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
    },
    /** Throws unless the visual document is exactly the projection of the shared text. */
    check() {
      const src = ytext.toString();
      if (bridge.model.parsed.src !== src) throw new Error('model is stale');
      const fresh = parse(src, bridge.model.parsed.transparent);
      if (JSON.stringify(fresh.blocks) !== JSON.stringify(bridge.model.parsed.blocks))
        throw new Error('incremental parse differs from a full parse');
      if (!state.doc.eq(project(model(fresh, bridge.model.phantom))))
        throw new Error('visual document is not the projection of the source');
    },
  };
}
export type Replica = ReturnType<typeof replica>;

export const textblocks = (r: Replica) => {
  const out: { start: number; size: number; para: boolean }[] = [];
  r.state.doc.descendants((n, pos) => {
    if (n.isTextblock)
      out.push({ start: pos + 1, size: n.content.size, para: n.type.name === 'paragraph' });
  });
  return out;
};

/** Document text with every atom as one placeholder, whitespace runs collapsed, empty lines gone. */
export const shown = (r: Replica) =>
  r.state.doc
    .textBetween(0, r.state.doc.content.size, '\n', '\ufffc')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

/** Source range of the display unit at index k of a text block; clamps to the content's edges. */
function unit(pieces: Piece[], k: number): [number, number] {
  const first = pieces.find((p) => p.k !== 'pre');
  const last = [...pieces].reverse().find((p) => p.k !== 'post');
  if (k < 0) return [first?.s ?? pieces.at(-1)?.e ?? 0, 0];
  let d = 0;
  for (const p of pieces) {
    const w = width(p);
    if (w && k < d + w) return p.k === 'text' ? [p.s + k - d, p.s + k - d + 1] : [p.s, p.e];
    d += w;
  }
  return [0, last?.e ?? pieces[0]?.e ?? 0];
}

export type Op = {
  what: string;
  /** Source range the edit is allowed to change. */
  lo: number;
  hi: number;
  /** A token the edit typed, if any. */
  token?: string;
  /** The edit emptied its text block. */
  whole: boolean;
  accepted: boolean;
};

/** Delete one top-level block (a formula, a figure, an empty heading, ...) as the editor would. */
function dropBlock(rep: Replica, pick: number): Op | null {
  const nodes: { pos: number; size: number }[] = [];
  rep.state.doc.forEach((n, pos) => {
    const t = n.type.name;
    if (t === 'math_block' || t === 'raw_block' || t === 'heading' || t === 'list')
      nodes.push({ pos, size: n.nodeSize });
  });
  if (!nodes.length) return null;
  const { pos, size } = nodes[pick % nodes.length];
  const blocks = rep.bridge.model.blocks;
  const k = rep.state.doc.resolve(pos).index(0);
  const prev = blocks[k - 1];
  const end = blocks[k].start + blocks[k].body.text.length;
  const lo = prev ? prev.start + prev.body.text.length : 0;
  const hi = blocks[k + 1]?.start ?? rep.src.length;
  const accepted = rep.dispatch(rep.state.tr.delete(pos, pos + size));
  return { what: 'drop', lo, hi: Math.max(hi, end), accepted, whole: false };
}

let serial = 0;
/** One random visual edit, applied through the bridge. Null if there was nothing to edit. */
export function visualOp(r: Rng, rep: Replica, only?: 'ins'): Op | null {
  const tbs = textblocks(rep);
  if (!tbs.length) return null;
  const tb = r.pick(tbs);
  const off = r.int(tb.size + 1);
  const len = Math.min(tb.size - off, r.int(5));
  const pos = tb.start + off;
  const spot = locate(rep.bridge.model, rep.state.doc, pos)!;
  // Fixed width, so a failing seed replays the same edits whatever ran before it.
  const token = `v${String(serial++ % 100000).padStart(5, '0')}q`;
  let lo = spot.base + unit(spot.pieces, off - 1)[0];
  const roll = only ? 0 : r.int(160);
  const { state } = rep;
  let what = 'ins';
  let hi = spot.base + unit(spot.pieces, off)[1];
  let accepted: boolean;
  // Leave the caret where an editor would: after typed text, inside a new paragraph.
  const caret = (tr: Transaction, at: number) =>
    tr.setSelection(TextSelection.near(tr.doc.resolve(at)));
  if (roll < 40)
    accepted = rep.dispatch(caret(state.tr.insertText(token, pos), pos + token.length));
  else if (roll < 75) {
    what = roll < 62 ? 'del' : 'rep';
    hi = spot.base + unit(spot.pieces, off + len)[1];
    // Deleting a whole line also takes the rest of that line: its trailing spaces and newline.
    hi += /^[ \t]*\n/.exec(rep.src.slice(hi, hi + 80))?.[0].length ?? 0;
    accepted = rep.dispatch(
      what === 'del' ? state.tr.delete(pos, pos + len) : state.tr.insertText(token, pos, pos + len),
    );
  } else if (roll < 84) {
    what = 'enter';
    accepted = rep.dispatch(caret(state.tr.split(pos), pos + 2));
  } else if (roll < 92) {
    what = 'join';
    const at = tb.start + tb.size + 1;
    if (!tb.para || !canJoin(state.doc, at)) return null;
    const next = locate(rep.bridge.model, state.doc, at + 1);
    if (!next) return null;
    hi = Math.max(hi, next.base + 1);
    accepted = rep.dispatch(state.tr.join(at));
  } else if (roll < 100) {
    what = 'emph';
    hi = spot.base + unit(spot.pieces, off + len)[1];
    rep.select(pos, pos + len);
    // Either mark, chosen without the generator so that a seed replays the edits it always did.
    const c = rep.bridge.markCommand(rep.state, pos % 2 ? 'emph' : 'textbf');
    accepted = !!c && rep.bridge.applyCommand(c) === 'applied';
  } else if (roll < 140) {
    // Delete, or type over, a selection that runs from one paragraph into a later one.
    what = 'xdel';
    // Selecting out of a just-opened empty paragraph removes it, and every position moves.
    if (rep.bridge.model.phantom) return null;
    const i = tbs.indexOf(tb);
    const tb2 = tbs[i + 1 + r.int(Math.min(3, tbs.length - i - 1) || 1)];
    if (!tb2) return null;
    const off2 = r.int(tb2.size + 1);
    const end = tb2.start + off2;
    const spot2 = locate(rep.bridge.model, state.doc, end)!;
    hi = spot2.base + unit(spot2.pieces, off2)[1];
    hi += /^[ \t]*\n/.exec(rep.src.slice(hi, hi + 80))?.[0].length ?? 0;
    rep.select(pos, end);
    if (r.int(2)) {
      what = 'xrep';
      accepted = rep.dispatch(rep.state.tr.insertText(token, pos, end));
    } else accepted = rep.dispatch(rep.state.tr.delete(pos, end));
  } else {
    // Enter over a selected stretch of one paragraph.
    what = 'xenter';
    if (rep.bridge.model.phantom) return null;
    // Where Enter has nothing to work on, a block is deleted instead. It is picked without the
    // generator, so that a seed still draws what it always drew.
    if (!tb.para || tb.size < 1) return dropBlock(rep, pos);
    const o = r.int(tb.size);
    const n = 1 + r.int(Math.min(4, tb.size - o));
    const from = tb.start + o;
    const at = locate(rep.bridge.model, state.doc, from)!;
    lo = at.base + unit(at.pieces, o - 1)[0];
    hi = at.base + unit(at.pieces, o + n)[1];
    hi += /^[ \t]*\n/.exec(rep.src.slice(hi, hi + 80))?.[0].length ?? 0;
    rep.select(from, from + n);
    accepted = rep.dispatch(caret(rep.state.tr.delete(from, from + n).split(from), from + 2));
  }
  const whole = len === tb.size;
  return {
    what,
    lo,
    hi,
    accepted,
    whole,
    token: what === 'ins' || what === 'rep' || what === 'xrep' ? token : undefined,
  };
}
