// Visual edit -> source splices. The bridge never regenerates LaTeX: it works out which source
// characters an edit touched and replaces exactly those.
import { NBSP, type Piece } from '@paperweave/latex';
import type { Node as PMNode } from '@tiptap/pm/model';
import { locate, markKey, type Model, type Phantom, width } from './project.ts';

/** Replace source [from, to) with insert. A list is sorted and never overlaps. */
export type Edit = { from: number; to: number; insert: string };
export type Translation = { edits: Edit[]; phantom: Phantom | null };

const ESCAPE: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  [NBSP]: '~',
  '\n': ' ',
  '\r': ' ',
  '\t': ' ',
};
for (const c of '%&$#_{}') ESCAPE[c] = '\\' + c;
export const escape = (s: string) => s.replace(/[\\~^\xa0\n\r\t%&$#_{}]/g, (c) => ESCAPE[c]);

// An odd run of backslashes then letters is a control word; an even run is a line break.
const AFTER_WORD = /(^|[^\\])(\\\\)*\\[a-zA-Z]+$/;
const AFTER_BREAK = /(^|[^\\])(\\\\)+$/;

/** The smallest changed range between two documents: before[a, endA) became after[a, endB). */
export function diff(before: PMNode, after: PMNode) {
  const a = before.content.findDiffStart(after.content);
  if (a == null) return null;
  let { a: endA, b: endB } = before.content.findDiffEnd(after.content)!;
  const overlap = a - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return { a, endA, endB };
}

/**
 * Where text with the given styles goes when typed at a display offset: the source offset
 * (relative to the block) and the piece index it sits before. Null if no such place exists.
 */
function gapFor(pieces: Piece[], off: number, marks: string): { at: number; gap: number } | null {
  let d = 0;
  let lo = 0;
  let hi = pieces.length;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const w = width(p);
    if (p.k === 'text' && d < off && off < d + w)
      return markKey(p.marks) === marks ? { at: p.s + off - d, gap: i + 0.5 } : null;
    if (w && d + w <= off) lo = i + 1;
    if (w && d >= off) {
      hi = i;
      break;
    }
    d += w;
  }
  const stack: string[] = [];
  for (let g = 0; g <= hi; g++) {
    // Never before the block's own opening (\item, \section{) or after its closing.
    const inside = pieces[g]?.k !== 'pre' && pieces[g - 1]?.k !== 'post';
    if (g >= lo && inside && markKey(stack) === marks)
      return { at: g < pieces.length ? pieces[g].s : (pieces[g - 1]?.e ?? 0), gap: g };
    const p = pieces[g];
    if (p?.k === 'open') stack.push(p.mark!);
    else if (p?.k === 'close') stack.pop();
  }
  return null;
}

/** Replace display range [off, offEnd) of one text block with plain text carrying `marks`. */
function replaceText(
  text: string,
  pieces: Piece[],
  off: number,
  offEnd: number,
  ins: string,
  marks: string,
): Edit[] | null {
  const del: [number, number][] = [];
  const gone = pieces.map(() => false);
  let fixed = false;
  let d = 0;
  pieces.forEach((p, i) => {
    const w = width(p);
    const x = Math.max(off, d);
    const y = Math.min(offEnd, d + w);
    if (w && x < y) {
      // A macro definition can break the whole build if it goes: only the source editor may.
      if (p.type === 'def') fixed = true;
      gone[i] = x === d && y === d + w;
      del.push(p.k === 'text' ? [p.s + x - d, p.s + y - d] : [p.s, p.e]);
    }
    d += w;
  });

  if (fixed) return null;

  let at = -1;
  let gap = -1;
  if (ins) {
    const g = gapFor(pieces, off, marks);
    if (!g) return null;
    ({ at, gap } = g);
    // A space typed just after a line break would vanish into the next line's indentation, so
    // it goes before the break instead. Both places show the same thing.
    const prev = pieces[gap - 1];
    if (prev?.k === 'ws' && /^ +$/.test(ins)) at = prev.s;
  }

  // A style group left with nothing in it goes too: \emph{} is noise.
  const open: number[] = [];
  pieces.forEach((p, j) => {
    if (p.k === 'open') open.push(j);
    if (p.k !== 'close' || !open.length) return;
    const i = open.pop()!;
    let shown = 0;
    let kept = gap > i && gap <= j ? 1 : 0;
    for (let k = i + 1; k < j; k++) {
      if (width(pieces[k])) shown++;
      if (width(pieces[k]) && !gone[k]) kept++;
    }
    if (shown && !kept) del.push([pieces[i].s, pieces[i].e], [p.s, p.e]);
  });

  del.sort((x, y) => x[0] - y[0]);
  const edits: Edit[] = [];
  for (const [from, to] of del) {
    const prev = edits[edits.length - 1];
    if (prev && from <= prev.to) prev.to = Math.max(prev.to, to);
    else edits.push({ from, to, insert: '' });
  }
  if (ins) {
    const host = edits.find((e) => e.from <= at && at <= e.to);
    if (host) host.insert = escape(ins);
    else edits.push({ from: at, to: at, insert: escape(ins) });
    edits.sort((x, y) => x.from - y.from);
  }
  for (const e of edits) {
    // Deleting everything on a line must not leave a blank line: that would split the paragraph.
    const eol = /^[ \t]*\n/.exec(text.slice(e.to, e.to + 80));
    if (!e.insert && eol && /\n[ \t]*$/.test(text.slice(Math.max(0, e.from - 80), e.from)))
      e.to += eol[0].length;
  }
  for (const e of edits)
    e.insert = guard(text.slice(0, e.from), e.insert || text[e.to] || '') + e.insert;
  return edits;
}

/** What must go between `tail` and `next` so that joining them does not change their meaning. */
function guard(tail: string, next: string) {
  const c = next[0] ?? '';
  // Anything placed after a comment on the same line would become part of the comment.
  const line = tail.slice(tail.lastIndexOf('\n') + 1);
  if (c && c !== '\n' && /(^|[^\\])(\\\\)*%/.test(line)) return '\n';
  // A letter after a command name would extend the name; * or [ would become its argument.
  tail = tail.slice(-64);
  const word = AFTER_WORD.test(tail);
  if (word && /[A-Za-z]/.test(c)) return '{}';
  if ((word || AFTER_BREAK.test(tail)) && (c === '*' || c === '[')) return '{}';
  return '';
}

const breakBefore = (src: string, at: number) =>
  at === 0 || /(^|\n)[ \t]*\n[ \t]*$/.test(src.slice(Math.max(0, at - 200), at));
const breakAfter = (src: string, at: number) =>
  at >= src.length || /^[ \t]*\n[ \t]*(\n|$)/.test(src.slice(at, at + 200));

/**
 * Work out the source edits for a change to the visual document, or null if the change is not one
 * the visual editor can express (the caller then refuses it and points the author to source mode).
 */
export function translate(
  m: Model,
  before: PMNode,
  after: PMNode,
  /** Where a single plain replacement happened, if the change was one. */
  hint?: { from: number; to: number; size: number },
): Translation | null {
  const dd = diff(before, after);
  if (!dd) return { edits: [], phantom: m.phantom };
  // Comparing documents cannot tell where "ab" went into "abab". When the editor says exactly
  // where it replaced text, use that, so the splice lands under the caret and nowhere else.
  const $from = hint && before.resolve(hint.from);
  if ($from?.parent.isTextblock && $from.sameParent(before.resolve(hint!.to)))
    Object.assign(dd, { a: hint!.from, endA: hint!.to, endB: hint!.from + hint!.size });
  const { a, endA, endB } = dd;
  const src = m.parsed.src;
  const $a = before.resolve(a);
  const $endA = before.resolve(endA);
  const abs = (base: number, edits: Edit[]) =>
    edits.map((e) => ({ from: e.from + base, to: e.to + base, insert: e.insert }));
  const para = (n: PMNode | null | undefined) => n?.type.name === 'paragraph';

  // A new empty paragraph before block i. It is anchored to the end of the block before it.
  const open = (i: number): Translation | null => {
    if (m.phantom) return null;
    const prev = m.blocks[i - 1];
    const srcPos = prev ? prev.start + prev.body.text.length : (m.blocks[0]?.start ?? src.length);
    return { edits: [], phantom: { index: i, srcPos } };
  };

  // Enter at the end of a block: a new empty paragraph appears between blocks.
  if (endA === a && $a.depth === 0 && endB === a + 2 && para(after.nodeAt(a)))
    return open($a.index(0));

  // Enter inside a paragraph.
  const $x = after.resolve(a);
  const $y = after.resolve(endB);
  if (endA === a && endB === a + 2 && $a.depth === 1 && para($a.parent) && !$x.sameParent($y)) {
    if (
      !para($x.parent) ||
      !para($y.parent) ||
      $x.parentOffset !== $x.parent.content.size ||
      $y.parentOffset
    )
      return null;
    const spot = locate(m, before, a)!;
    if (spot.block < 0) return null;
    // Enter at the end of one paragraph and Enter at the start of the next produce the same
    // document. The bridge keeps the new paragraph only if the caret ends up inside it.
    if (spot.off === 0) return open($a.index(0));
    const g = gapFor(spot.pieces, spot.off, '');
    return (
      g && { edits: abs(spot.base, [{ from: g.at, to: g.at, insert: '\n\n' }]), phantom: m.phantom }
    );
  }

  // Backspace at the start of a paragraph: it joins the one before.
  if (
    endB === a &&
    endA === a + 2 &&
    $a.depth === 1 &&
    $endA.depth === 1 &&
    !$a.sameParent($endA)
  ) {
    if (!para($a.parent) || !para($endA.parent) || $endA.parentOffset) return null;
    if ($a.parentOffset !== $a.parent.content.size) return null;
    const x = locate(m, before, a)!;
    const y = locate(m, before, endA)!;
    if (x.block < 0 || y.block < 0) return { edits: [], phantom: null };
    const from = x.base + x.text.length;
    const insert = guard(src.slice(0, from), src[y.base] ?? '');
    return { edits: [{ from, to: y.base, insert }], phantom: m.phantom };
  }

  // Typing, deleting or replacing text inside one text block.
  if (!$a.parent.isTextblock || !$a.sameParent($endA)) return null;
  if (!$x.parent.isTextblock || !$x.sameParent($y)) return null;
  let ins = '';
  let marks: string | null = null;
  let plain = true;
  after.slice(a, endB).content.forEach((n) => {
    const key = markKey(n.marks.map((k) => k.type.name));
    if (!n.isText || (marks !== null && marks !== key)) plain = false;
    marks = key;
    ins += n.text ?? '';
  });
  if (!plain) return null;
  const spot = locate(m, before, a)!;
  if (spot.block < 0) {
    if (marks) return null;
    if (!ins.trim()) return { edits: [], phantom: m.phantom };
    const at = spot.base;
    const insert =
      (breakBefore(src, at) ? '' : '\n\n') + escape(ins) + (breakAfter(src, at) ? '' : '\n\n');
    return { edits: [{ from: at, to: at, insert }], phantom: null };
  }
  const edits = replaceText(
    spot.text,
    spot.pieces,
    spot.off,
    spot.off + endA - a,
    ins,
    marks ?? '',
  );
  return edits && { edits: abs(spot.base, edits), phantom: m.phantom };
}

/**
 * Source range and replacement for wrapping the display range in \emph{...}, or for removing the
 * \emph that exactly encloses it. Null if the range does not nest cleanly.
 */
export function emphEdit(text: string, pieces: Piece[], off: number, offEnd: number): Edit | null {
  let d = 0;
  let first = -1;
  let last = -1;
  let from = 0;
  let to = 0;
  pieces.forEach((p, i) => {
    const w = width(p);
    const x = Math.max(off, d);
    const y = Math.min(offEnd, d + w);
    if (w && x < y) {
      if (first < 0) {
        first = i;
        from = p.k === 'text' ? p.s + x - d : p.s;
      }
      last = i;
      to = p.k === 'text' ? p.s + y - d : p.e;
    }
    d += w;
  });
  if (first < 0) return null;
  // Inside a group a definition would become local to it and vanish afterwards.
  if (pieces.slice(first, last + 1).some((p) => p.type === 'def')) return null;
  let depth = 0;
  for (let i = first + 1; i < last; i++) {
    if (pieces[i].k === 'open') depth++;
    if (pieces[i].k === 'close' && --depth < 0) return null;
  }
  if (depth) return null;
  const open = pieces[first - 1];
  const close = pieces[last + 1];
  const whole = from === pieces[first].s && to === pieces[last].e;
  if (whole && open?.k === 'open' && open.mark === 'emph' && close?.k === 'close')
    return { from: open.s, to: close.e, insert: text.slice(from, to) };
  return { from, to, insert: `\\emph{${text.slice(from, to)}}` };
}
