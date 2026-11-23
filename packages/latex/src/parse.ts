// Lossless LaTeX block parser. Every character of the source belongs to exactly one piece of
// exactly one block, so a wrong parse can change what is displayed but never what is stored.

import { accented, LIGATURES } from './bib.ts';
import { CITES, MULTICITES, REFS } from './labels.ts';

export type Mark = 'emph' | 'textbf' | 'textit' | 'texttt';

/** A contiguous source range inside a block. Offsets are relative to the block start. */
export type Piece = {
  /**
   * text, ws, esc and atom are displayed; open, close, pre and post take no room in the visual
   * document. A ws piece is a line break plus indentation, shown as one space.
   */
  k: 'text' | 'ws' | 'esc' | 'atom' | 'open' | 'close' | 'pre' | 'post';
  s: number;
  e: number;
  marks: Mark[];
  /** esc: the one UTF-16 unit shown, so an esc is always one display position. */
  ch?: string;
  /** atom: what it is. A def is a macro definition: shown, but never touched by a visual edit. */
  type?: 'math' | 'ref' | 'cite' | 'raw' | 'def';
  /** open/close: which style. */
  mark?: Mark;
};

export type Body =
  | { kind: 'para'; text: string; pieces: Piece[] }
  | { kind: 'heading'; text: string; level: number; pieces: Piece[] }
  | { kind: 'list'; text: string; ordered: boolean; items: { pieces: Piece[] }[] }
  | { kind: 'math'; text: string }
  | { kind: 'raw'; text: string; label: string }
  | { kind: 'ws'; text: string }
  | { kind: 'error'; text: string; message: string };

export type Block = { start: number; body: Body };
export type Parsed = { src: string; blocks: Block[]; transparent: ReadonlySet<string> };

const HEAD: Record<string, number> = {
  part: 1,
  chapter: 1,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};
const STYLE = new Set(['emph', 'textbf', 'textit', 'texttt']);
/** Font switches written inside a group, `{\em word}`, and the style each one gives its group. */
const SWITCH: Record<string, Mark> = {
  em: 'emph',
  it: 'textit',
  itshape: 'textit',
  bf: 'textbf',
  bfseries: 'textbf',
  tt: 'texttt',
  ttfamily: 'texttt',
};
// The same commands labels.ts indexes, so that every reference it counts is a ref or cite atom here.
// \hyperref[key]{text} is left out: its key is in the brackets and its braces hold prose.
const REF = new Set([...REFS].filter((n) => n !== 'hyperref'));
const CITE = CITES;
/** Commands whose first brace group is verbatim: a % in it is part of the address. */
const VERB_ARG = new Set(['url', 'nolinkurl', 'path', 'href']);
/** Commands whose argument is written between delimiters, as \verb|x| or \lstinline{x}. */
const CODE_INLINE = new Set(['verb', 'lstinline', 'mintinline']);
/** Commands that define something: their arguments include bare names and mid-way brackets. */
const DEFS = new Set([
  ...['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand', 'newenvironment'],
  ...['renewenvironment', 'def', 'gdef', 'edef', 'xdef', 'let', 'newtheorem'],
  ...['DeclareMathOperator'],
]);
const TEXT_ESC: Record<string, string> = {
  textbackslash: '\\',
  textasciitilde: '~',
  textasciicircum: '^',
  textless: '<',
  textgreater: '>',
  textbar: '|',
};
const ACCENT_SYM = /\\([`'^"~=.])(?:([a-zA-Z])|\{([a-zA-Z]|\\[ij])\})/y;
const ACCENT_LET = /\\([cvHkur])\{([a-zA-Z]|\\[ij])\}/y;
/**
 * Commands that print one character and take nothing from the text around them: the national
 * letters and a few symbols. Each is one display position.
 */
export const TEXT_WORDS = [
  ...['ss', 'ae', 'AE', 'oe', 'OE', 'aa', 'AA', 'o', 'O', 'l', 'L'],
  ...['ldots', 'dots', 'textellipsis', 'textendash', 'textemdash', 'slash', 'thinspace'],
  ...['copyright', 'textcopyright', 'textregistered', 'texttrademark', 'textdegree'],
  ...['texteuro', 'pounds', 'textsterling'],
];
/** The name, then `{}` or the spaces and tabs on the same line that TeX skips after a name. */
const NATIONAL = new RegExp(`\\\\(${TEXT_WORDS.join('|')})(?![a-zA-Z])(?:\\{\\}|[ \\t]+)?`, 'y');
/** What \, prints. */
export const THIN = '\u2009';
const ESC_SYM = new Set(['%', '&', '$', '#', '_', '{', '}', ' ']);
const SPECIAL = new Set(['\\', '{', '}', '$', '%', '~', '&', '#', '^', '_', ' ', '\t', '\n']);
export const MATH_ENV: ReadonlySet<string> = new Set(
  ['equation', 'align', 'gather', 'multline', 'eqnarray', 'displaymath', 'flalign', 'alignat']
    .flatMap((n) => [n, n + '*'])
    .concat('math'),
);
export const VERBATIM: ReadonlySet<string> = new Set([
  'verbatim',
  'verbatim*',
  'lstlisting',
  'minted',
  'Verbatim',
  'comment',
]);
/** Environments whose body is ordinary prose: only their \begin and \end lines are raw. */
export const DEFAULT_TRANSPARENT: ReadonlySet<string> = new Set([
  ...['abstract', 'quote', 'quotation', 'center', 'flushleft', 'flushright', 'appendices'],
  ...['IEEEkeywords', 'keywords', 'proof', 'theorem', 'lemma', 'corollary', 'proposition'],
  ...['definition', 'remark', 'example', 'sloppypar', 'multicols', 'multicols*'],
  // Publisher front matter and acknowledgments (elsarticle, IEEEtran).
  ...['frontmatter', 'keyword', 'acknowledgments', 'acknowledgements', 'acknowledgment'],
  ...['acknowledgement', 'acks', 'IEEEproof'],
  // Theorem-like environments llncs predefines (acmart adds conjecture).
  ...['claim', 'conjecture', 'property', 'problem', 'exercise', 'question', 'solution'],
  ...['note', 'case'],
]);

export const HARD =
  /\\(?:part|chapter|(?:sub){0,2}section|(?:sub)?paragraph)(?![a-zA-Z])|\\end\{document\}/g;
export const BRK = /\n[ \t]*\n/g;
const BRK_AT = /\n[ \t]*\n/;
const LEN_NAME = String.raw`\\(?:itemsep|parskip|parsep|topsep|partopsep|itemindent|leftmargin|labelsep|labelwidth)`;
const LIST_LENGTH = new RegExp(
  String.raw`(?:\\setlength\s*(?:\{${LEN_NAME}\}|${LEN_NAME})\s*\{[^{}%\n]*\}|${LEN_NAME}\s*=?\s*-?[\d.]+\s*(?:pt|em|ex|mm|cm|in|bp|sp|pc))`,
  'y',
);
/** A command with nothing after its name: it may be a declaration, which lasts to the end of its group. */
const BARE = /^\\[a-zA-Z@]+\*?$/;
const ENV = /\{([^{}\\%\n]+)\}/y;
const DOC = '\\begin{document}';
/** How a tie (~) is shown: a non-breaking space. */
export const NBSP = String.fromCharCode(0xa0);

class Unbalanced extends Error {
  /** para: the damage ends at the next blank line. hard: it may run to the next heading. */
  scope: 'para' | 'hard';
  constructor(scope: 'para' | 'hard', message: string) {
    super(message);
    this.scope = scope;
  }
}
/** Thrown inside a style group or list item that turns out to hold block-level content. */
const ABORT = Symbol('abort');

const isL = (c: string | undefined) => !!c && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isW = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';
const isS = (c: string | undefined) => c === ' ' || c === '\t';
/** Length in UTF-16 units of the character at i: 2 for a surrogate pair, so no boundary splits one. */
const cpLen = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  const d = s.charCodeAt(i + 1);
  return c >= 0xd800 && c < 0xdc00 && d >= 0xdc00 && d < 0xe000 ? 2 : 1;
};

export function parse(src: string, transparent: ReadonlySet<string> = DEFAULT_TRANSPARENT): Parsed {
  const blocks: Block[] = [];
  let i = 0;
  const d = src.indexOf(DOC);
  if (d >= 0) {
    i = d + DOC.length;
    blocks.push({ start: 0, body: { kind: 'raw', text: src.slice(0, i), label: 'preamble' } });
  }
  parseInto(blocks, src, i, transparent, () => false);
  return { src, blocks, transparent };
}

/** A file the visual editor shows as one untouchable block, such as a file of definitions. */
export function sourceOnly(src: string): Parsed {
  const body: Body = { kind: 'raw', text: src, label: 'source only' };
  return { src, blocks: src ? [{ start: 0, body }] : [], transparent: DEFAULT_TRANSPARENT };
}

/**
 * Reparse after an edit, reusing every block the edit could not have affected. Parsing a block is a
 * pure function of the text from its start onward, so once a new block boundary lines up with an
 * old one past the edit, the rest of the old blocks are reused.
 */
export function reparse(prev: Parsed, src: string): Parsed {
  const old = prev.src;
  if (old === src) return prev;
  const max = Math.min(old.length, src.length);
  let p = 0;
  while (p < max && old.charCodeAt(p) === src.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && old.charCodeAt(old.length - 1 - s) === src.charCodeAt(src.length - 1 - s))
    s++;
  // The preamble is the one block decided by text before it, so re-decide it from scratch.
  const near = (t: string) => t.slice(Math.max(0, p - 20), t.length - s + 20).includes('document}');
  if (near(old) || near(src)) return parse(src, prev.transparent);

  const ob = prev.blocks;
  let k = ob.findIndex((b) => b.start + b.body.text.length > p);
  if (k < 0) k = ob.length;
  // A block's end can depend on the first token of what follows it, so back up past that reach.
  k = Math.max(0, k - 3);
  // Inline math that is unclosed or has braces that never balance is decided by scanning ahead
  // as far as the next blank line or heading, which can be past the end of its own block. So an
  // edit can change any block back to there: restart at the last such boundary before the edit.
  // The margin keeps a boundary that the edit itself touches from counting.
  const cut = Math.max(0, p - 24);
  let bb = -1;
  for (let j = old.lastIndexOf('\n', cut); j > 0 && bb < 0; j = old.lastIndexOf('\n', j - 1)) {
    let q = j - 1;
    while (old[q] === ' ' || old[q] === '\t') q--;
    if (old[q] === '\n') bb = q;
  }
  let reach = Math.max(bb, 0);
  HARD.lastIndex = reach;
  for (let h = HARD.exec(old); h && h.index + h[0].length <= cut; h = HARD.exec(old))
    reach = h.index;
  const kb = ob.findIndex((b) => b.start + b.body.text.length > reach);
  if (kb >= 0) k = Math.min(k, kb);
  // A frozen block was decided by scanning to the end of the file, so any edit can change it.
  const err = ob.findIndex((b) => b.body.kind === 'error');
  if (err >= 0) k = Math.min(k, err);
  if (k === 0 || (k === 1 && ob[0].body.kind === 'raw' && ob[0].body.label === 'preamble'))
    return parse(src, prev.transparent);

  const delta = src.length - old.length;
  const oldEnd = old.length - s;
  const blocks = ob.slice(0, k);
  let m = k;
  parseInto(blocks, src, ob[k].start, prev.transparent, (at) => {
    const q = at - delta;
    if (q <= oldEnd) return false;
    while (m < ob.length && ob[m].start < q) m++;
    if (m >= ob.length || ob[m].start !== q) return false;
    for (let j = m; j < ob.length; j++)
      blocks.push({ start: ob[j].start + delta, body: ob[j].body });
    return true;
  });
  return { src, blocks, transparent: prev.transparent };
}

function parseInto(
  blocks: Block[],
  src: string,
  from: number,
  transparent: ReadonlySet<string>,
  /** Called at each block boundary; returning true means the caller finished the list itself. */
  done: (at: number) => boolean,
) {
  const n = src.length;

  /** End of the control sequence starting at the backslash at i. */
  const word = (i: number) => {
    let j = i + 1;
    if (j >= n) return j;
    if (!isL(src[j])) return j + cpLen(src, j);
    while (isL(src[j])) j++;
    return j;
  };
  /**
   * A TeX accent, national letter or text symbol at the backslash at i that is exactly one
   * displayed character: \'e, \"{o}, \c{c}, \ss{}, \ldots. A name takes the {} or same-line
   * spaces after it, as TeX does. Purely local; no accent with a space in it, and no pair without
   * a single precomposed character.
   */
  const accentAt = (i: number): { end: number; ch: string } | null => {
    for (const re of [ACCENT_SYM, ACCENT_LET]) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m) {
        const ch = accented(m[1], m[2] ?? m[3]);
        return ch.length === 1 ? { end: re.lastIndex, ch } : null;
      }
    }
    NATIONAL.lastIndex = i;
    const m = NATIONAL.exec(src);
    if (m && Object.hasOwn(LIGATURES, m[1])) {
      const ch = LIGATURES[m[1]];
      return ch.length === 1 ? { end: NATIONAL.lastIndex, ch } : null;
    }
    return null;
  };
  const wsEnd = (i: number) => {
    while (isW(src[i])) i++;
    return i;
  };
  /** Index after the newline ending the line at i, or n. */
  const lineEnd = (i: number) => {
    const j = src.indexOf('\n', i);
    return j < 0 ? n : j + 1;
  };
  /** A whitespace run [i, j) holds a blank line, which ends a paragraph. */
  const isBreak = (i: number, j: number) => {
    let nl = 0;
    for (let k = i; k < j; k++) if (src[k] === '\n') nl++;
    return nl >= 2 || (nl === 1 && (i === 0 || src[i - 1] === '\n'));
  };
  const blankAt = (j: number) => {
    let k = j + 1;
    while (isS(src[k])) k++;
    return src[k] === '\n';
  };
  /** Index of the newline ending the line at i, or n. */
  const eol = (i: number) => {
    const j = src.indexOf('\n', i);
    return j < 0 ? n : j;
  };
  /** A heading or the end of the document: no inline construct may reach across one. */
  const hardAt = (i: number) =>
    src.slice(i + 1, word(i)) in HEAD || src.startsWith('\\end{document}', i);
  /** Where damage that starts at i must stop: the next blank line or hard boundary. */
  const limit = (i: number, scope: 'para' | 'hard') => {
    let end = n;
    HARD.lastIndex = i + 1;
    const h = HARD.exec(src);
    if (h) end = h.index;
    if (scope === 'para') {
      BRK.lastIndex = i;
      const b = BRK.exec(src);
      if (b && b.index < end) end = b.index;
    }
    return end;
  };
  /**
   * Index after the brace group opening at i, taken as it is (no comments), or -1. It does not
   * cross a blank line or `lim`, so what it decides never depends on text far past where it is.
   */
  const rawGroup = (i: number, lim = n) => {
    let d = 0;
    for (let j = i; j < lim; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}' && --d === 0) return j + 1;
      else if (src[j] === '\n' && blankAt(j)) return -1;
    }
    return -1;
  };
  /**
   * Index after the argument of \verb, \lstinline or \mintinline whose name ends at j: written
   * between two equal characters (to the end of the line if the second never comes), or for the
   * last two in braces. -1 if there is none here.
   */
  const codeEnd = (name: string, j: number, lim = n) => {
    let k = j;
    if (name === 'verb') {
      if (src[k] === '*') k++;
    } else {
      if (src[k] === '[') {
        const b = bracket(k);
        if (b < 0) return -1;
        k = b;
      }
      if (name === 'mintinline') {
        const g = src[k] === '{' ? rawGroup(k, lim) : -1;
        if (g < 0) return -1;
        k = g;
      }
      if (k >= n || isW(src[k]) || isL(src[k])) return -1;
      if (src[k] === '{') return rawGroup(k, lim);
    }
    const nl = eol(k);
    const w = cpLen(src, k);
    const close = k < n ? src.indexOf(src.slice(k, k + w), k + w) : -1;
    return close >= 0 && close < nl ? close + w : nl;
  };
  /** End of the control sequence at i, with the verbatim argument of one that has such. */
  const cmdEnd = (i: number, lim = n) => {
    const j = word(i);
    if (!isL(src[i + 1])) return j;
    const name = src.slice(i + 1, j);
    if (CODE_INLINE.has(name)) {
      const e = codeEnd(name, j, lim);
      if (e >= 0) return e;
    } else if (VERB_ARG.has(name) && src[j] === '{') {
      const g = rawGroup(j, lim);
      if (g >= 0) return g;
    }
    return j;
  };
  /** Index after the brace group opening at i, or -1. */
  const group = (i: number) => {
    let d = 0;
    let j = i;
    while (j < n) {
      const c = src[j];
      if (c === '\\') j = cmdEnd(j);
      else if (c === '%') j = lineEnd(j);
      else {
        if (c === '{') d++;
        else if (c === '}' && --d === 0) return j + 1;
        j++;
      }
    }
    return -1;
  };
  /** Index after the [optional argument] opening at i, or -1 if it is not one. */
  const bracket = (i: number) => {
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        if (hardAt(j)) return -1;
        j = cmdEnd(j);
      } else if (c === '%') j = eol(j);
      else if (c === '{') {
        const g = group(j);
        if (g < 0) return -1;
        j = g;
      } else if (c === ']') return j + 1;
      else if (c === '\n' && blankAt(j)) return -1;
      else j++;
    }
    return -1;
  };
  /**
   * Index where inline math starting before i closes, or -1 if it does not close in time. A
   * brace group is skipped whole, so the $ in $x \text{ if $y$ holds}$ do not end the formula.
   * Braces that never balance before the paragraph ends are taken as plain characters.
   */
  const mathEnd = (i: number, closes: (q: number) => boolean, braces = true): number => {
    let k = i;
    let d = 0;
    while (k < n) {
      if (d === 0 && closes(k)) return k;
      const c = src[k];
      if (c === '\\') {
        if (hardAt(k)) break;
        k = cmdEnd(k);
      } else if (c === '%') k = eol(k);
      else if (c === '\n' && blankAt(k)) break;
      else {
        if (braces && c === '{') d++;
        else if (braces && c === '}' && d > 0) d--;
        k++;
      }
    }
    return braces && d > 0 ? mathEnd(i, closes, false) : -1;
  };
  const envName = (j: number) => {
    ENV.lastIndex = j;
    const m = ENV.exec(src);
    return m ? { name: m[1], end: ENV.lastIndex } : null;
  };
  const cmdAt = (i: number, name: string) =>
    src.startsWith(name, i + 1) && src[i] === '\\' && !isL(src[i + 1 + name.length]);
  const envAt = (i: number, which: 'begin' | 'end') =>
    cmdAt(i, which) ? envName(i + 1 + which.length) : null;
  /** Something that always starts its own block. */
  const blockStartAt = (i: number) => {
    if (src[i] === '$') return src[i + 1] === '$';
    if (src[i] !== '\\') return false;
    if (src[i + 1] === '[') return true;
    const name = src.slice(i + 1, word(i));
    return name in HEAD || !!envAt(i, 'begin') || !!envAt(i, 'end');
  };
  /** An unknown command with the arguments written directly after it. */
  const unit = (i: number) => {
    let j = word(i);
    const sym = !isL(src[i + 1]);
    if (sym && src[i + 1] !== '\\') return j;
    const name = src.slice(i + 1, word(i));
    if (CODE_INLINE.has(name)) {
      const e = codeEnd(name, j);
      if (e >= 0) return e;
    }
    if (src[j] === '*') j++;
    if (DEFS.has(name)) {
      // \newcommand{\x}[1]{...}, \def\x#1{...}, \let\a=\b: take the whole definition.
      for (let body = false; ;) {
        const c = src[j];
        if (c === '{') {
          const g = group(j);
          if (g < 0) throw new Unbalanced('hard', 'unclosed {');
          j = g;
          body = true;
        } else if (c === '[' && bracket(j) > 0) j = bracket(j);
        else if (c === '#' && src[j + 1] >= '1' && src[j + 1] <= '9') j += 2;
        else if (c === '\\' && !body && isL(src[j + 1])) j = word(j);
        else if (c === '=' && !body) j++;
        else return j;
      }
    }
    while (src[j] === '[') {
      const b = bracket(j);
      if (b < 0) break;
      j = b;
    }
    // The address of \url{..} and \href{..}{..} is taken as it is: a % in it is not a comment.
    for (let first = VERB_ARG.has(name); !sym && src[j] === '{'; first = false) {
      const g = first ? rawGroup(j) : group(j);
      if (g < 0) throw new Unbalanced('hard', 'unclosed {');
      j = g;
    }
    return j;
  };
  const findEnd = (from: number, name: string) => {
    const open = `\\begin{${name}}`;
    const shut = `\\end{${name}}`;
    let depth = 1;
    let j = from;
    while (j < n) {
      const c = src[j];
      if (c === '%') j = lineEnd(j);
      else if (c !== '\\') j++;
      else if (src.startsWith(open, j)) {
        depth++;
        j += open.length;
      } else if (src.startsWith(shut, j)) {
        j += shut.length;
        if (--depth === 0) return j;
      } else j = cmdEnd(j, eol(j));
    }
    return -1;
  };

  /** Index after spaces, and one line break if no blank line follows it: where TeX looks next. */
  const skipWs = (k: number) => {
    while (isS(src[k])) k++;
    if (src[k] === '\n') {
      let m = k + 1;
      while (isS(src[m])) m++;
      if (m < n && src[m] !== '\n') return m;
    }
    return k;
  };
  /**
   * Index after one `[pre][post]{keys}` of a citation, with an `<pre>` note and, first in a
   * multicite, `(pre)(post)` notes, and whitespace between all of them; -1 if it is not whole.
   */
  const citeUnit = (from: number, parens: boolean) => {
    let k = from;
    if (parens)
      for (;;) {
        const q = skipWs(k);
        const close = src[q] === '(' ? src.indexOf(')', q) : -1;
        if (close < 0 || /\n[ \t]*\n/.test(src.slice(q, close))) break;
        k = close + 1;
      }
    k = skipWs(k);
    if (src[k] === '<') {
      const close = src.indexOf('>', k);
      if (close < 0 || /\n[ \t]*\n/.test(src.slice(k, close))) return -1;
      k = close + 1;
    }
    for (let b = 0; b < 2; b++) {
      k = skipWs(k);
      if (src[k] !== '[') break;
      const end = bracket(k);
      if (end < 0) return -1;
      k = end;
    }
    k = skipWs(k);
    return src[k] === '{' ? group(k) : -1;
  };

  /**
   * A group that opens with a font switch, `{\em `, at the brace at i: its style and where its
   * text starts, after the spaces and the one line break TeX skips behind a command name.
   */
  const switchAt = (i: number): { mark: Mark; end: number } | null => {
    if (src[i + 1] !== '\\' || !isL(src[i + 2])) return null;
    const j = word(i + 1);
    const name = src.slice(i + 2, j);
    if (!Object.hasOwn(SWITCH, name)) return null;
    // `{\em{}` is how the bridge keeps a typed letter out of the name.
    if (src.startsWith('{}', j)) return { mark: SWITCH[name], end: j + 2 };
    let k = j;
    while (isS(src[k])) k++;
    if (src[k] === '\n' && !blankAt(k)) {
      k++;
      while (isS(src[k])) k++;
    }
    return { mark: SWITCH[name], end: k };
  };

  /** Parse inline content from i. Returns where it stopped; b0 is the block start. */
  const inline = (
    i: number,
    b0: number,
    depth: number,
    marks: Mark[],
    out: Piece[],
    list: boolean,
  ): number => {
    const push = (k: Piece['k'], s: number, e: number, extra?: Partial<Piece>) =>
      out.push({ k, s: s - b0, e: e - b0, marks, ...extra });
    /** Block-level content ends a paragraph, but cannot sit inside a style group or list item. */
    const stopBlock = () => {
      if (depth > 0 || list) throw ABORT;
    };
    while (i < n) {
      const c = src[i];
      if (isW(c)) {
        const j = wsEnd(i);
        // Spaces are shown one for one. A line break with its indentation is shown as one space.
        let k = i;
        while (isS(src[k])) k++;
        if (k > i) push('text', i, k);
        if (k === j) {
          i = j;
          continue;
        }
        const brk = isBreak(i, j);
        if (depth > 0) {
          if (brk) throw ABORT;
        } else {
          const nextItem = list && (cmdAt(j, 'item') || !!envAt(j, 'end'));
          if (list ? nextItem : brk || j === n || blockStartAt(j)) {
            if (!list) return k;
            push('post', k, j);
            return j;
          }
          if (list && brk) throw ABORT;
        }
        push('ws', k, j);
        i = j;
      } else if (c === '%') {
        // The newline stays outside the comment so it still separates words and paragraphs.
        // Comment lines that follow one another are one note, as they are between paragraphs.
        let j = eol(i);
        for (;;) {
          let k = j + 1;
          while (isS(src[k])) k++;
          if (k >= n || src[k] !== '%') break;
          j = eol(k);
        }
        push('atom', i, j, { type: 'raw' });
        i = j;
      } else if (c === '\\') {
        const j = word(i);
        const name = src.slice(i + 1, j);
        if (!isL(name[0])) {
          if (ESC_SYM.has(name)) push('esc', i, j, { ch: name });
          else if (name === ',') push('esc', i, j, { ch: THIN });
          else if (name === '(') {
            const k = mathEnd(j, (q) => src[q] === '\\' && src[q + 1] === ')');
            if (k < 0) throw new Unbalanced('para', 'unclosed \\(');
            push('atom', i, k + 2, { type: 'math' });
            i = k + 2;
            continue;
          } else if (name === '[') {
            stopBlock();
            return i;
          } else {
            const a = accentAt(i);
            if (a) {
              push('esc', i, a.end, { ch: a.ch });
              i = a.end;
              continue;
            }
            const e = unit(i);
            push('atom', i, e, { type: 'raw' });
            i = e;
            continue;
          }
          i = j;
          continue;
        }
        if (name in HEAD || envAt(i, 'begin')) {
          stopBlock();
          return i;
        }
        if (envAt(i, 'end') || (list && name === 'item')) {
          if (depth > 0) throw ABORT;
          return i;
        }
        if (STYLE.has(name) && src[j] === '{') {
          const mark = name as Mark;
          const inner: Piece[] = [];
          try {
            const close = inline(j + 1, b0, depth + 1, [...marks, mark], inner, list);
            push('open', i, j + 1, { mark });
            out.push(...inner);
            push('close', close, close + 1, { mark });
            i = close + 1;
          } catch (err) {
            if (err !== ABORT) throw err;
            const g = group(j);
            if (g < 0) throw new Unbalanced('hard', `unclosed \\${name}{`);
            push('atom', i, g, { type: 'raw' });
            i = g;
          }
          continue;
        }
        let e = -1;
        let type: Piece['type'] = 'raw';
        if (REF.has(name)) {
          let k = src[j] === '*' ? j + 1 : j;
          for (let b = 0; b < 2; b++) {
            const q = skipWs(k);
            if (src[q] !== '[') break;
            const end = bracket(q);
            if (end < 0) break;
            k = end;
          }
          // \crefrange{first}{last} names two labels, in two groups.
          for (let g = 0; g < (name.endsWith('range') ? 2 : 1); g++) {
            const q = skipWs(k);
            if (src[q] !== '{') break;
            const end = group(q);
            if (end < 0) {
              e = -1;
              break;
            }
            k = e = end;
          }
          type = 'ref';
        } else if (CITE.has(name)) {
          // \cite [p] {k}, \cite<pre>{k}, and a multicite's `(pre)(post)` and repeated units.
          const multi = MULTICITES.has(name);
          let k = src[j] === '*' ? j + 1 : j;
          for (let unit = 0; unit === 0 || multi; unit++) {
            const end = citeUnit(k, multi && unit === 0);
            if (end < 0) break;
            k = e = end;
          }
          type = 'cite';
        } else if (name in TEXT_ESC && src.startsWith('{}', j)) {
          push('esc', i, j + 2, { ch: TEXT_ESC[name] });
          i = j + 2;
          continue;
        } else if (name === 'symbol' && src.startsWith('{34}', j)) {
          push('esc', i, j + 4, { ch: '"' });
          i = j + 4;
          continue;
        } else {
          const a = accentAt(i);
          if (a) {
            push('esc', i, a.end, { ch: a.ch });
            i = a.end;
            continue;
          }
        }
        if (e < 0) {
          e = unit(i);
          type = DEFS.has(name) ? 'def' : 'raw';
        }
        push('atom', i, e, { type });
        i = e;
      } else if (c === '{') {
        const a = src[i + 1] === '\\' ? accentAt(i + 1) : null;
        if (a && src[a.end] === '}') {
          push('esc', i, a.end + 1, { ch: a.ch });
          i = a.end + 1;
          continue;
        }
        const sw = switchAt(i);
        if (sw) {
          const inner: Piece[] = [];
          let close = -1;
          try {
            close = inline(sw.end, b0, depth + 1, [...marks, sw.mark], inner, list);
          } catch (err) {
            // Whatever is wrong inside, the group is what it was before: one piece of LaTeX.
            if (err !== ABORT && !(err instanceof Unbalanced)) throw err;
          }
          // A bare command inside may be a declaration (\small) that the braces keep in: such a
          // group stays whole, so no visual edit can take its braces away and let it out.
          const plain =
            close >= 0 &&
            inner.some((q) => q.k === 'text' || q.k === 'esc') &&
            !inner.some(
              (q) =>
                q.k === 'atom' &&
                q.type !== 'math' &&
                q.type !== 'ref' &&
                q.type !== 'cite' &&
                BARE.test(src.slice(q.s + b0, q.e + b0)),
            );
          if (plain) {
            push('open', i, sw.end, { mark: sw.mark });
            out.push(...inner);
            push('close', close, close + 1, { mark: sw.mark });
            i = close + 1;
            continue;
          }
        }
        const g = group(i);
        if (g < 0) throw new Unbalanced('hard', 'unclosed {');
        push('atom', i, g, { type: 'raw' });
        i = g;
      } else if (c === '}') {
        if (depth > 0) return i;
        throw new Unbalanced('para', 'unexpected }');
      } else if (c === '$') {
        if (src[i + 1] === '$') {
          stopBlock();
          return i;
        }
        const k = mathEnd(i + 1, (q) => src[q] === '$');
        if (k < 0) throw new Unbalanced('para', 'unclosed $');
        push('atom', i, k + 1, { type: 'math' });
        i = k + 1;
      } else if (c === '~') {
        push('esc', i, i + 1, { ch: NBSP });
        i++;
      } else if (c === '&' || c === '#' || c === '^' || c === '_') {
        push('atom', i, i + 1, { type: 'raw' });
        i++;
      } else {
        let j = i + 1;
        while (j < n && !SPECIAL.has(src[j])) j++;
        push('text', i, j);
        i = j;
      }
    }
    if (depth > 0) throw new Unbalanced('hard', 'unclosed {');
    if (list) throw new Unbalanced('hard', 'unclosed list');
    return n;
  };

  const raw = (i: number, j: number, label: string): Body => ({
    kind: 'raw',
    text: src.slice(i, j),
    label,
  });

  /**
   * What may stand between \\begin{itemize} and the first \\item and prints nothing: an option on
   * the same line (`[noitemsep]`, `[label=(\\alph*)]`), comment lines, and a length set for the
   * list (`\\setlength\\itemsep{0pt}`, `\\itemsep 0pt`). The index after it, or `from`.
   */
  const listHead = (from: number) => {
    let j = from;
    let o = j;
    while (isS(src[o])) o++;
    if (src[o] === '[') {
      let depth = 0;
      let c = o + 1;
      for (; c < n && c - o <= 300; c++) {
        const ch = src[c];
        if (ch === '\\') c++;
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '%' || ch === '\n' || depth < 0) return from;
        else if (ch === ']' && !depth) break;
      }
      if (src[c] !== ']' || depth) return from;
      j = c + 1;
    }
    for (;;) {
      const k = wsEnd(j);
      if (BRK_AT.test(src.slice(j, k))) return j;
      if (src[k] === '%') j = lineEnd(k);
      else {
        LIST_LENGTH.lastIndex = k;
        const m = LIST_LENGTH.exec(src);
        if (!m) return j;
        j = k + m[0].length;
      }
    }
  };

  const list = (i: number, bodyStart: number, close: number, name: string): Body | null => {
    const shut = `\\end{${name}}`.length;
    try {
      let k = wsEnd(listHead(bodyStart));
      if (!cmdAt(k, 'item')) return null;
      const items: { pieces: Piece[] }[] = [];
      let pre = i;
      for (;;) {
        if (src[k + 5] === '[') return null;
        const s = wsEnd(k + 5);
        const pieces: Piece[] = [];
        // An empty item keeps only the spaces on its own line in `pre`; the line break and the
        // indentation of the next \item are `post`, so text typed in it lands before them.
        const empty = cmdAt(s, 'item') || !!envAt(s, 'end');
        let sp = k + 5;
        while (isS(src[sp])) sp++;
        const e = empty ? sp : s;
        pieces.push({ k: 'pre', s: pre - i, e: e - i, marks: [] });
        let stop: number;
        if (empty) {
          if (s > e) pieces.push({ k: 'post', s: e - i, e: s - i, marks: [] });
          stop = s;
        } else stop = inline(s, i, 0, [], pieces, true);
        items.push({ pieces });
        if (cmdAt(stop, 'item')) {
          k = pre = stop;
          continue;
        }
        if (stop + shut !== close) return null;
        pieces.push({ k: 'post', s: stop - i, e: close - i, marks: [] });
        return { kind: 'list', text: src.slice(i, close), ordered: name === 'enumerate', items };
      }
    } catch (err) {
      if (err === ABORT || err instanceof Unbalanced) return null;
      throw err;
    }
  };

  const block = (i: number): Body => {
    const c = src[i];
    if (c === '%') {
      // Whole-line comments standing on their own are a block; inside a paragraph they are inline.
      let j = eol(i);
      for (;;) {
        let k = j + 1;
        while (isS(src[k])) k++;
        if (src[k] !== '%') break;
        j = eol(k);
      }
      let k = j + 1;
      while (isS(src[k])) k++;
      if (k >= n || src[k] === '\n' || blockStartAt(k)) return raw(i, j, 'comment');
    }
    if (c === '$' && src[i + 1] === '$') {
      const k = src.indexOf('$$', i + 2);
      if (k < 0 || k >= limit(i, 'para')) throw new Unbalanced('para', 'unclosed $$');
      return { kind: 'math', text: src.slice(i, k + 2) };
    }
    if (c === '\\') {
      const j = word(i);
      const name = src.slice(i + 1, j);
      if (name === '[') {
        const k = src.indexOf('\\]', j);
        if (k < 0 || k >= limit(i, 'para')) throw new Unbalanced('para', 'unclosed \\[');
        return { kind: 'math', text: src.slice(i, k + 2) };
      }
      if (name in HEAD) {
        let k = j;
        if (src[k] === '*') k++;
        if (src[k] === '[') {
          const b = bracket(k);
          if (b > 0) k = b;
        }
        if (src[k] !== '{') return raw(i, unit(i), name);
        const pieces: Piece[] = [{ k: 'pre', s: 0, e: k + 1 - i, marks: [] }];
        let close: number;
        try {
          close = inline(k + 1, i, 1, [], pieces, false);
        } catch (err) {
          if (err === ABORT) throw new Unbalanced('hard', `unclosed \\${name}{`);
          throw err;
        }
        pieces.push({ k: 'post', s: close - i, e: close + 1 - i, marks: [] });
        return { kind: 'heading', level: HEAD[name], text: src.slice(i, close + 1), pieces };
      }
      const begin = envAt(i, 'begin');
      if (begin) {
        const { name: env, end } = begin;
        if (transparent.has(env) || env === 'document') {
          // Its arguments belong to the \begin line: \begin{theorem}[Name], \begin{multicols}{2}.
          let k = end;
          for (;;) {
            const e = src[k] === '[' ? bracket(k) : src[k] === '{' ? group(k) : -1;
            if (e < 0) break;
            k = e;
          }
          return raw(i, k, env);
        }
        if (VERBATIM.has(env)) {
          const k = src.indexOf(`\\end{${env}}`, end);
          if (k < 0) throw new Unbalanced('hard', `\\begin{${env}} without \\end`);
          return raw(i, k + env.length + 6, env);
        }
        const close = findEnd(end, env);
        if (close < 0) throw new Unbalanced('hard', `\\begin{${env}} without \\end`);
        if (MATH_ENV.has(env)) return { kind: 'math', text: src.slice(i, close) };
        if (env === 'itemize' || env === 'enumerate') {
          const l = list(i, end, close, env);
          if (l) return l;
        }
        return raw(i, close, env);
      }
      const end = envAt(i, 'end');
      if (end) {
        if (end.name === 'document') return raw(i, n, 'end document');
        if (transparent.has(end.name)) return raw(i, end.end, 'end');
        throw new Unbalanced('para', `\\end{${end.name}} without \\begin`);
      }
      const inlineCmd =
        STYLE.has(name) ||
        REF.has(name) ||
        CITE.has(name) ||
        name in TEXT_ESC ||
        (name === 'symbol' && src.startsWith('{34}', j));
      if (isL(name[0]) && !inlineCmd && !CODE_INLINE.has(name)) {
        // A command alone on its line (\maketitle, \input{x}, \label{y}) is its own block.
        const e = unit(i);
        let k = e;
        while (isS(src[k])) k++;
        if (k >= n || src[k] === '\n') return raw(i, e, name);
        if (src[k] === '%') {
          const le = lineEnd(k);
          return raw(i, src[le - 1] === '\n' ? le - 1 : le, name);
        }
      }
    }
    const pieces: Piece[] = [];
    const end = inline(i, i, 0, [], pieces, false);
    return { kind: 'para', text: src.slice(i, end), pieces };
  };

  let i = from;
  while (i < n) {
    if (done(i)) return;
    let body: Body;
    if (isW(src[i])) body = { kind: 'ws', text: src.slice(i, wsEnd(i)) };
    else {
      try {
        body = block(i);
      } catch (err) {
        if (!(err instanceof Unbalanced)) throw err;
        // Freeze from here to the nearest boundary the damage cannot cross.
        let end = limit(i, err.scope);
        while (end > i + 1 && isW(src[end - 1])) end--;
        body = { kind: 'error', text: src.slice(i, end), message: err.message };
      }
    }
    blocks.push({ start: i, body });
    i += body.text.length;
  }
}

/** Every text block inside a block: one for a paragraph or heading, one per list item. */
export function textblocks(body: Body): Piece[][] {
  if (body.kind === 'para' || body.kind === 'heading') return [body.pieces];
  if (body.kind === 'list') return body.items.map((it) => it.pieces);
  return [];
}
