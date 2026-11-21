// Whether replacing one inline atom's source left the text around it read as it was.
import { BRK, DEFAULT_TRANSPARENT, HARD, type Parsed, parse, textblocks } from './parse.ts';

type Leaf = { s: number; e: number; own: string; tag: string; atom: boolean; def: boolean };

/** Every stretch of source that is read as one thing, in order, with where it sits. */
function leaves(p: Parsed): Leaf[] {
  const out: Leaf[] = [];
  p.blocks.forEach((b, bi) => {
    const tbs = textblocks(b.body);
    if (!tbs.length) {
      const own = `${bi}:${b.body.kind}`;
      const more = 'label' in b.body ? b.body.label : 'message' in b.body ? b.body.message : '';
      out.push({
        s: b.start,
        e: b.start + b.body.text.length,
        own,
        tag: `${own}:${more}`,
        atom: false,
        def: false,
      });
      return;
    }
    tbs.forEach((pieces, ii) => {
      const own = `${bi}:${b.body.kind}:${ii}`;
      for (const q of pieces)
        out.push({
          s: b.start + q.s,
          e: b.start + q.e,
          own,
          tag: `${own}:${q.k}:${q.type ?? ''}:${q.mark ?? ''}:${q.ch ?? ''}:${q.marks.join()}`,
          atom: q.k === 'atom',
          def: q.type === 'def',
        });
    });
  });
  return out;
}

/**
 * Whether replacing the `was` bytes at `from` of `old`'s source (one inline atom that is not a
 * definition) with `len` bytes gave `now` with everything else read as it was: every piece and
 * block outside the atom the same, shifted by the change in length, and the new pieces exactly
 * covering the replacement, in the same block and list item.
 */
export function contained(
  old: Parsed,
  now: Parsed,
  from: number,
  was: number,
  len: number,
): boolean {
  const a = leaves(old);
  const b = leaves(now);
  const i = a.findIndex((l) => l.s === from && l.e === from + was);
  if (i < 0 || !a[i].atom || a[i].def) return false;
  const after = a.length - i - 1;
  const j = b.length - after;
  if (j <= i) return false;
  for (let k = 0; k < i; k++)
    if (a[k].s !== b[k].s || a[k].e !== b[k].e || a[k].tag !== b[k].tag) return false;
  const d = len - was;
  for (let k = 1; k <= after; k++) {
    const x = a[a.length - k];
    const y = b[b.length - k];
    if (x.s + d !== y.s || x.e + d !== y.e || x.tag !== y.tag) return false;
  }
  if (b[i].s !== from || b[j - 1].e !== from + len || len === 0) return false;
  for (let k = i; k < j; k++) if (b[k].own !== a[i].own) return false;
  return true;
}

/** The most source `containedNear` will parse. One paragraph with no blank line can be any size. */
export const WINDOW_CAP = 256 * 1024;
/** Same margin as `reparse`: a boundary the edit itself touches does not count as one. */
const MARGIN = 24;
const DOC = '\\begin{document}';

/**
 * `contained` for the text `now` and a replacement of its bytes [from, from + was), parsing only a
 * window around the edit instead of the whole file, so the cost follows the paragraph and not the
 * file (a full parse of 50 MB runs out of memory).
 *
 * The window runs from two paragraphs before the edit to two paragraphs after it. Its start is
 * the last blank line, or heading, that lies before `from - MARGIN` (the rule `reparse` restarts
 * on, since the parser treats those as safe places to begin), taken twice; its end is the second
 * blank line after `to + MARGIN`, or the end of the text. The second paragraph on each side means
 * a replacement that spills into its neighbour is still seen to.
 *
 * It does not use `reparse`: that needs a parse of the whole file to start from, which is the cost
 * being avoided, and it still parses on to the end of the file.
 *
 * If the window would pass WINDOW_CAP (one giant paragraph, say) the answer is false, which the
 * callers report as a conflict. It never falls back to a full parse: refusing is safe, a crash is
 * not. The preamble is kept apart, as the whole-file parse reads it: see the comment below.
 */
export function containedNear(
  now: string,
  from: number,
  was: number,
  replacement: string,
  transparent: ReadonlySet<string> = DEFAULT_TRANSPARENT,
): boolean {
  const to = from + was;
  const d = now.indexOf(DOC);
  if (d >= 0 ? from < d + DOC.length : replacement.includes(DOC)) return false;
  const n = now.length;
  const floor = Math.max(0, from - WINDOW_CAP);
  /** Start of the paragraph before `at`, or -1 if it lies past the floor. */
  const startBefore = (at: number): number => {
    if (at <= 0) return 0;
    const cut = Math.max(0, at - MARGIN);
    let bb = -1;
    for (
      let j = now.lastIndexOf('\n', cut);
      j > floor && bb < 0;
      j = now.lastIndexOf('\n', j - 1)
    ) {
      let q = j - 1;
      while (now[q] === ' ' || now[q] === '\t') q--;
      if (now[q] === '\n') bb = q;
    }
    if (bb < 0 && floor > 0) return -1;
    let at2 = Math.max(bb, 0);
    HARD.lastIndex = at2;
    for (let h = HARD.exec(now); h && h.index + h[0].length <= cut; h = HARD.exec(now))
      // Only a heading that begins its line is certainly where a block begins; `\\end{document}`,
      // or a heading inside a line, can sit in the middle of a paragraph.
      if (h[0][1] !== 'e' && now[h.index - 1] === '\n') at2 = h.index;
    return at2;
  };
  const s1 = startBefore(from);
  const s = s1 < 0 ? -1 : startBefore(s1);
  if (s < 0) return false;
  // Two paragraphs on: the end of the second blank-line break after `to + MARGIN`.
  let e = Math.min(n, to + MARGIN);
  for (let k = 0; k < 2 && e < n; k++) {
    BRK.lastIndex = e;
    const m = BRK.exec(now);
    e = m ? m.index + (k === 1 ? 0 : m[0].length) : n;
    if (e - s > WINDOW_CAP) return false;
  }
  if (e - s > WINDOW_CAP) return false;
  // The text up to the first `\begin{document}` is one block of preamble, and nothing in it is an
  // atom. A later `\begin{document}` is only text. A window that starts after the preamble is
  // given a one-line preamble of its own, so what it reads of those matches the whole file.
  let start = s;
  let head = '';
  if (d >= 0) {
    start = Math.max(s, d + DOC.length);
    head = DOC;
  }
  if (e - start > WINDOW_CAP) return false;
  const before = head + now.slice(start, e);
  const after = head + now.slice(start, from) + replacement + now.slice(to, e);
  return contained(
    parse(before, transparent),
    parse(after, transparent),
    from - start + head.length,
    was,
    replacement.length,
  );
}
