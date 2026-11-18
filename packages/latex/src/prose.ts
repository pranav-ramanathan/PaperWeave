// The prose of a LaTeX file, for a grammar checker: what is running text, what stands in for
// each thing that is not (a formula, a citation, a command), and where each is in the source.
// A checker that is told "this is markup, read it as that" answers in source positions.
import { DEFAULT_TRANSPARENT, parse, textblocks } from './parse.ts';

/** One stretch of the source, as LanguageTool's annotated text has it. */
export type Annotated = { text: string } | { markup: string; interpretAs: string };
export type Segment = {
  from: number;
  to: number;
  /**
   * `text` is prose. `soft` is a line break or an escaped character inside prose. `hard` is
   * everything a checker must never propose to change: formulas, references, citations,
   * commands and their arguments, code, comments, the preamble.
   */
  kind: 'text' | 'soft' | 'hard';
};

/** A word that reads as a noun, so that a sentence with a formula in it is still a sentence. */
const NOUN = 'Dummy';
/** The same after "an", which wants a vowel. */
const VOWEL_NOUN = 'Item';

export function prose(src: string, transparent: ReadonlySet<string> = DEFAULT_TRANSPARENT) {
  const annotation: Annotated[] = [];
  const segments: Segment[] = [];
  /** What has been said so far, as the checker will read it: to choose a stand-in that fits. */
  let read = '';
  const add = (from: number, to: number, kind: Segment['kind'], as?: string) => {
    if (to <= from) return;
    const part = src.slice(from, to);
    annotation.push(kind === 'text' ? { text: part } : { markup: part, interpretAs: as ?? '' });
    segments.push({ from, to, kind });
    read = (read + (kind === 'text' ? part : (as ?? ''))).slice(-8);
  };
  const noun = () => (/\ban\s*$/i.test(read) ? VOWEL_NOUN : NOUN);
  let at = 0;
  for (const { start, body } of parse(src, transparent).blocks) {
    const end = start + body.text.length;
    const blocks = textblocks(body);
    if (!blocks.length) {
      // A formula set apart is part of the sentence around it. Anything else ends a paragraph.
      const as =
        body.kind === 'math'
          ? ` ${noun()} `
          : body.kind === 'ws' && !/\n[ \t]*\n/.test(body.text)
            ? ' '
            : '\n\n';
      add(at, end, 'hard', as);
      at = end;
      continue;
    }
    for (const pieces of blocks) {
      for (const p of pieces) {
        const [from, to] = [start + p.s, start + p.e];
        // What lies between pieces (there should be nothing) is not prose.
        add(at, from, 'hard', '');
        at = to;
        // Code is written in a typewriter face; it is not English.
        const code = p.marks.includes('texttt');
        if (p.k === 'text') add(from, to, code ? 'hard' : 'text', code ? noun() : undefined);
        else if (p.k === 'ws') add(from, to, 'soft', ' ');
        else if (p.k === 'esc') add(from, to, code ? 'hard' : 'soft', p.ch ?? '');
        else if (p.k === 'atom')
          add(from, to, 'hard', p.type === 'cite' ? '[1]' : p.type === 'ref' ? '1' : noun());
        // The command that opens a heading or a style, and the brace that closes it.
        else add(from, to, 'hard', '');
      }
      // Between the items of a list, and after a heading.
      const next = pieces === blocks.at(-1) ? end : at;
      add(at, next, 'hard', '');
      at = next;
      annotation.push({ markup: '', interpretAs: '\n\n' });
      read = '';
    }
  }
  add(at, src.length, 'hard', '');
  return {
    annotation: annotation.filter((a) => 'text' in a || a.markup || a.interpretAs),
    segments,
  };
}

/**
 * Whether a finding at [from, to) may be shown: it is in prose, and touches nothing that must
 * not be changed.
 */
export function inProse(segments: Segment[], from: number, to: number): boolean {
  let text = false;
  for (const s of segments) {
    if (s.to <= from || s.from >= to) continue;
    if (s.kind === 'hard') return false;
    if (s.kind === 'text') text = true;
  }
  return text;
}
