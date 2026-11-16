import { type Parsed, textblocks } from './parse.ts';

/**
 * How much of a file the visual editor can edit as text, by source characters.
 * `editable` is prose in paragraphs, headings and list items; `atoms` are supported objects shown
 * in place (maths, references, citations); `raw` is everything shown but only editable in source.
 * The preamble, whitespace between blocks and comments are structure, not prose, and are left out.
 */
export function coverage(parsed: Parsed) {
  const c = { editable: 0, atoms: 0, raw: 0, frozen: 0 };
  for (const { body } of parsed.blocks) {
    if (body.kind === 'ws') continue;
    if (body.kind === 'error') c.frozen += body.text.length;
    else if (body.kind === 'math') c.atoms += body.text.length;
    else if (body.kind === 'raw') {
      const structural =
        ['preamble', 'comment', 'end', 'end document'].includes(body.label) ||
        parsed.transparent.has(body.label);
      if (!structural) c.raw += body.text.length;
    }
    for (const pieces of textblocks(body))
      for (const p of pieces) {
        const len = p.e - p.s;
        if (p.k === 'text' || p.k === 'ws' || p.k === 'esc') c.editable += len;
        else if (p.k === 'atom') {
          if (p.type === 'raw' || p.type === 'def') {
            if (!body.text.startsWith('%', p.s)) c.raw += len;
          } else c.atoms += len;
        }
      }
  }
  return c;
}
