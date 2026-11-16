// LaTeX blocks -> ProseMirror document, and positions between the two.
import type { Block, Body, Mark, Parsed, Piece } from '@paperweave/latex';
import { Fragment, Mark as PMMark, type Node as PMNode, type Schema } from '@tiptap/pm/model';

/**
 * An empty paragraph the author just opened with Enter. LaTeX cannot store an empty paragraph, so
 * it lives only in the visual document until something is typed into it.
 */
export type Phantom = { index: number; srcPos: number };
export type Model = { parsed: Parsed; blocks: Block[]; phantom: Phantom | null };

export const model = (parsed: Parsed, phantom: Phantom | null = null): Model => ({
  parsed,
  blocks: parsed.blocks.filter((b) => b.body.kind !== 'ws'),
  phantom,
});

export const markKey = (marks: readonly string[]) => [...new Set(marks)].sort().join(',');
/** How many positions a piece takes up in the visual document. */
export const width = (p: Piece) =>
  p.k === 'text' ? p.e - p.s : p.k === 'ws' || p.k === 'esc' || p.k === 'atom' ? 1 : 0;

const ATOM = {
  math: 'math_inline',
  ref: 'ref',
  cite: 'cite',
  raw: 'raw_inline',
  def: 'raw_inline',
} as const;

/**
 * Builds the visual document for a model. The editor owns the schema instance, so the projector is
 * made per editor; unchanged blocks keep their parsed body object across edits, so their nodes are
 * reused as they are.
 */
export function projector(schema: Schema): (m: Model) => PMNode {
  const pmMarks = (marks: Mark[]) => PMMark.setFrom(marks.map((m) => schema.marks[m].create()));
  const inline = (pieces: Piece[], text: string): Fragment => {
    const out: PMNode[] = [];
    let buf = '';
    let bufMarks: Mark[] = [];
    const flush = () => {
      if (buf) out.push(schema.text(buf, pmMarks(bufMarks)));
      buf = '';
    };
    for (const p of pieces) {
      if (p.k === 'atom') {
        flush();
        const src = text.slice(p.s, p.e);
        out.push(schema.nodes[ATOM[p.type!]].create({ src }, null, pmMarks(p.marks)));
        continue;
      }
      const shown =
        p.k === 'text' ? text.slice(p.s, p.e) : p.k === 'ws' ? ' ' : p.k === 'esc' ? p.ch! : '';
      if (!shown) continue;
      if (markKey(p.marks) !== markKey(bufMarks)) flush();
      buf += shown;
      bufMarks = p.marks;
    }
    flush();
    return Fragment.fromArray(out);
  };
  const cache = new WeakMap<Body, PMNode>();
  const node = (body: Body): PMNode => {
    let n = cache.get(body);
    if (n) return n;
    const { nodes } = schema;
    if (body.kind === 'para') n = nodes.paragraph.create(null, inline(body.pieces, body.text));
    else if (body.kind === 'heading')
      n = nodes.heading.create({ level: body.level }, inline(body.pieces, body.text));
    else if (body.kind === 'list')
      n = nodes.list.create(
        { ordered: body.ordered },
        body.items.map((it) => nodes.list_item.create(null, inline(it.pieces, body.text))),
      );
    else if (body.kind === 'math') n = nodes.math_block.create({ src: body.text });
    else if (body.kind === 'error')
      n = nodes.frozen.create({ src: body.text, message: body.message });
    else n = nodes.raw_block.create({ src: body.text, label: (body as { label: string }).label });
    cache.set(body, n);
    return n;
  };
  return (m) => {
    const children = m.blocks.map((b) => node(b.body));
    if (m.phantom) children.splice(m.phantom.index, 0, schema.nodes.paragraph.create());
    return schema.topNodeType.create(null, children);
  };
}

export type Spot = {
  /** Index into model.blocks, or -1 for the phantom paragraph. */
  block: number;
  /** Position of the text block's first character in the visual document. */
  contentStart: number;
  /** Display offset inside the text block. */
  off: number;
  pieces: Piece[];
  /** Source text and absolute start of the block the pieces index into. */
  text: string;
  base: number;
};

/** The text block around a visual position, or null if the position is not inside one. */
export function locate(m: Model, doc: PMNode, pos: number): Spot | null {
  const $p = doc.resolve(pos);
  if (!$p.parent.isTextblock) return null;
  const i = $p.index(0);
  const spot = { contentStart: $p.start(), off: $p.parentOffset };
  if (m.phantom && i === m.phantom.index)
    return { ...spot, block: -1, pieces: [], text: '', base: m.phantom.srcPos };
  const block = m.phantom && i > m.phantom.index ? i - 1 : i;
  const { start, body } = m.blocks[block];
  const pieces =
    body.kind === 'list' ? body.items[$p.index(1)].pieces : (body as { pieces: Piece[] }).pieces;
  return { ...spot, block, pieces, text: body.text, base: start };
}

/**
 * Source offset of a visual position. Markup such as `\emph{` sits between two visible
 * characters; `side` says which of them the offset should stay next to: -1 the one before (a
 * caret, or the end of a selection), 1 the one after (the start of a selection).
 */
export function toSrc(m: Model, doc: PMNode, pos: number, side: -1 | 1 = -1): number {
  const spot = locate(m, doc, pos);
  if (!spot) {
    const i = doc.resolve(pos).index(0);
    const b = m.blocks[m.phantom && i > m.phantom.index ? i - 1 : i];
    return b ? b.start : m.parsed.src.length;
  }
  let d = 0;
  let at = spot.pieces.find((p) => p.k !== 'pre')?.s ?? 0;
  for (const p of spot.pieces) {
    const w = width(p);
    if (!w) continue;
    if (spot.off < d + w) {
      if (p.k === 'text' && spot.off > d) return spot.base + p.s + spot.off - d;
      return spot.base + (side > 0 ? p.s : at);
    }
    d += w;
    at = p.e;
  }
  return spot.base + at;
}

/** Visual position of a caret at a source offset. */
export function fromSrc(m: Model, doc: PMNode, src: number): number {
  let i = m.blocks.findIndex((b) => b.start + b.body.text.length > src);
  if (i < 0) i = m.blocks.length - 1;
  if (i < 0) return 0;
  // A caret in the whitespace between two blocks belongs to the end of the earlier one.
  if (m.blocks[i].start > src && i > 0) i--;
  const { start, body } = m.blocks[i];
  const child = m.phantom && i >= m.phantom.index ? i + 1 : i;
  let pos = 0;
  for (let k = 0; k < child; k++) pos += doc.child(k).nodeSize;
  const tbs =
    body.kind === 'list'
      ? body.items.map((it) => it.pieces)
      : 'pieces' in body
        ? [body.pieces]
        : [];
  if (!tbs.length) return pos;
  const rel = Math.max(0, src - start);
  pos += body.kind === 'list' ? 1 : 0;
  for (const pieces of tbs) {
    const last = pieces[pieces.length - 1];
    let d = 0;
    if (pieces === tbs[tbs.length - 1] || rel < last.e) {
      for (const p of pieces) {
        if (rel < p.e) return pos + 1 + d + (p.k === 'text' ? Math.max(0, rel - p.s) : 0);
        d += width(p);
      }
      return pos + 1 + d;
    }
    pos += pieces.reduce((n, p) => n + width(p), 2);
  }
  return pos;
}
