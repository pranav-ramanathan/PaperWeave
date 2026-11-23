// The prose of a LaTeX file, for a grammar checker: what is running text, what stands in for
// each thing that is not (a formula, a citation, a command), and where each is in the source.
// The command that opens a list item reads as a bullet, so an item is not taken for a sentence.
// A list the parser keeps raw (a description, an item with an option or a nested list in it) is
// read from inside: its items read as bullets, and the term of a description item is not prose.
// A checker that is told "this is markup, read it as that" answers in source positions.
import { logoOf } from './bib.ts';
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
  /** Soft only: what the checker reads in its place (a space, `á`, `%`). */
  as?: string;
};

/** A word that reads as a noun, so that a sentence with a formula in it is still a sentence. */
const NOUN = 'Dummy';
/** The same after "an", which wants a vowel. */
const VOWEL_NOUN = 'Item';

const LIST = /^\\begin\{(itemize|enumerate|description)\}(?:\[[^\]\n]*\])?/;
const ITEM = /^\\item(?![a-zA-Z])/;
/** What a list item's opening command reads as: a bullet, and a plain term as the label it prints. */
const bullet = (item: string) => {
  const term = /^\\item\[([\p{L}\p{N}][\p{L}\p{N} '-]*)\]$/u.exec(item);
  return term ? `\n\n• ${term[1]}:` : '\n\n•';
};

export function prose(src: string, transparent: ReadonlySet<string> = DEFAULT_TRANSPARENT) {
  const annotation: Annotated[] = [];
  const segments: Segment[] = [];
  /** What has been said so far, as the checker will read it: to choose a stand-in that fits. */
  let read = '';
  const add = (from: number, to: number, kind: Segment['kind'], as?: string) => {
    if (to <= from) return;
    const part = src.slice(from, to);
    annotation.push(kind === 'text' ? { text: part } : { markup: part, interpretAs: as ?? '' });
    segments.push(kind === 'soft' ? { from, to, kind, as: as ?? '' } : { from, to, kind });
    read = (read + (kind === 'text' ? part : (as ?? ''))).slice(-8);
  };
  const noun = () => (/\ban\s*$/i.test(read) ? VOWEL_NOUN : NOUN);
  let at = 0;
  const walk = (lo: number, hi: number, inList: boolean, depth: number) => {
    const found = parse(lo === 0 && hi === src.length ? src : src.slice(lo, hi), transparent);
    for (const b of found.blocks) {
      const start = lo + b.start;
      const body = b.body;
      const end = start + body.text.length;
      const blocks = textblocks(body);
      if (!blocks.length) {
        const list = body.kind === 'raw' ? LIST.exec(body.text) : null;
        if (
          list &&
          depth < 8 &&
          body.text.endsWith(`\\end{${list[1]}}`) &&
          !body.text.includes('\\begin{document}')
        ) {
          add(at, start + list[0].length, 'hard', '\n\n');
          at = start + list[0].length;
          read = '';
          walk(at, end - (list[1].length + 6), true, depth + 1);
          add(at, end, 'hard', '\n\n');
          at = end;
          read = '';
          continue;
        }
        if (inList && body.kind === 'raw' && body.label === 'item') {
          add(at, end, 'hard', bullet(body.text));
          at = end;
          read = '';
          continue;
        }
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
          else if (p.k === 'atom' && inList && ITEM.test(src.slice(from, to))) {
            add(from, to, 'hard', bullet(src.slice(from, to)));
            read = '';
          } else if (p.k === 'atom')
            add(
              from,
              to,
              'hard',
              p.type === 'cite'
                ? '[1]'
                : p.type === 'ref'
                  ? '1'
                  : p.type === 'raw'
                    ? (logoOf(src.slice(from, to)) ?? noun())
                    : noun(),
            );
          // The command that opens a list item reads as the bullet it prints. Any other command
          // that opens a heading or a style, and the brace that closes it, reads as nothing.
          else add(from, to, 'hard', body.kind === 'list' && p.k === 'pre' ? '• ' : '');
        }
        // Between the items of a list, and after a heading. Each item is a line of its own, opened
        // by a bullet, so that it may start in lower case.
        const next = pieces === blocks.at(-1) ? end : at;
        add(at, next, 'hard', '');
        at = next;
        annotation.push({ markup: '', interpretAs: '\n\n' });
        read = '';
      }
    }
  };
  walk(0, src.length, false, 0);
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

/**
 * The stretch [from, to) as the checker read it: prose as written, an escaped character or
 * accent as its character, a line break as a space. For a stretch that is `inProse`.
 */
export function readAs(src: string, segments: Segment[], from: number, to: number): string {
  let out = '';
  for (const s of segments) {
    if (s.to <= from || s.from >= to) continue;
    if (s.kind === 'text') out += src.slice(Math.max(s.from, from), Math.min(s.to, to));
    else if (s.kind === 'soft') out += s.as ?? '';
  }
  return out;
}
