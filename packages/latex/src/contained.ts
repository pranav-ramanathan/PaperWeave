// Whether replacing one inline atom's source left the text around it read as it was.
import { type Parsed, textblocks } from './parse.ts';

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
