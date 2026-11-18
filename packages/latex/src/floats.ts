// The parts of a figure or table that people edit without thinking of them as LaTeX: the
// caption, the picture and its description, the cells of a simple table. Each part comes with
// where it is in the source, so that changing one changes those characters and no others.

/** A stretch of the source: what it says and where it is. */
export type Span = { text: string; at: number; end: number };
export type Graphic = {
  /** The file named, as written. */
  target: Span;
  /** The description for people who cannot see the picture: `alt={...}` in the options. */
  alt: Span | null;
  /** Where a new option would go: just inside the closing bracket, or -1 if there are no options. */
  optionsEnd: number;
  /** Where options would start if there are none: just after `\includegraphics`. */
  commandEnd: number;
};
export type Table = {
  /** Rows of cells. A cell's span is its own text, without the space around it. */
  rows: Span[][];
  /**
   * True if it is a plain grid. False if it has something a grid cannot show (a cell across
   * columns or rows, a table inside a table) or rows of different lengths.
   */
  simple: boolean;
};
export type Float = {
  kind: 'figure' | 'table';
  caption: Span | null;
  graphics: Graphic[];
  table: Table | null;
};

/** The offset just past the group that opens at `at`, or -1 if it never closes. */
function closeOf(src: string, at: number, open = '{', close = '}') {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '%') while (i < src.length && src[i] !== '\n') i++;
    else if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}
/** `src` with comments blanked, so that offsets still hold and commented-out text is not found. */
const live = (src: string) =>
  src.replace(
    /(^|[^\\])%.*$/gm,
    (all, before: string) => before + ' '.repeat(all.length - before.length),
  );
const span = (src: string, at: number, end: number): Span => ({
  text: src.slice(at, end),
  at,
  end,
});
/** The span with the white space at both ends left out. */
function trimmed(src: string, at: number, end: number): Span {
  while (at < end && /\s/.test(src[at])) at++;
  while (end > at && /\s/.test(src[end - 1])) end--;
  return span(src, at, end);
}

const RULE = /^\\(hline|toprule|midrule|bottomrule|addlinespace|cline|cmidrule|noalign)\b/;

function tableOf(src: string, text: string): Table | null {
  const begin = /\\begin\{(tabular\*?|tabularx)\}/.exec(text);
  if (!begin) return null;
  // The column specification, after a width for the kinds that take one.
  let at = begin.index + begin[0].length;
  for (let groups = begin[1] === 'tabular' ? 1 : 2; groups > 0; groups--) {
    while (/\s/.test(text[at] ?? '')) at++;
    if (text[at] === '[') at = closeOf(text, at, '[', ']');
    at = text[at] === '{' ? closeOf(text, at) : -1;
    if (at < 0) return null;
  }
  const end = text.indexOf(`\\end{${begin[1]}}`, at);
  if (end < 0) return null;
  const body = text.slice(at, end);
  let simple = !/\\(multicolumn|multirow|begin)\b/.test(body);
  const rows: Span[][] = [];
  let row: Span[] = [];
  let cell = at;
  const closeCell = (to: number) => row.push(trimmed(src, cell, to));
  const closeRow = () => {
    // A last line with only rules on it, or nothing, is not a row.
    if (row.length > 1 || row[0]?.text) rows.push(row);
    row = [];
  };
  for (let i = at; i < end; i++) {
    // Rules sit at the start of a row and are not part of any cell.
    if (!row.length && !text.slice(cell, i).trim()) {
      const rule = RULE.exec(text.slice(i, i + 16));
      if (rule) {
        i += rule[0].length;
        for (;;) {
          while (text[i] === ' ') i++;
          if (text[i] === '{') i = closeOf(text, i);
          else if (text[i] === '(') i = closeOf(text, i, '(', ')');
          else if (text[i] === '[') i = closeOf(text, i, '[', ']');
          else break;
          if (i < 0) return null;
        }
        cell = i;
        i--;
        continue;
      }
    }
    const c = text[i];
    if (c === '{') {
      const close = closeOf(text, i);
      if (close < 0) return null;
      i = close - 1;
    } else if (c === '\\' && text[i + 1] === '\\') {
      closeCell(i);
      closeRow();
      i += 2;
      // \\* and \\[2pt] are still just the end of a row.
      if (text[i] === '*') i++;
      if (text[i] === '[') i = closeOf(text, i, '[', ']');
      if (i < 0) return null;
      cell = i;
      i--;
    } else if (c === '\\') i++;
    else if (c === '&') {
      closeCell(i);
      cell = i + 1;
    }
  }
  closeCell(end);
  closeRow();
  if (rows.some((r) => r.length !== rows[0].length)) simple = false;
  return { rows, simple };
}

/**
 * Read a figure or table environment: `src` is the whole of it, from `\begin` to `\end`.
 * Returns null for anything else.
 */
export function floatParts(src: string): Float | null {
  const kind = /^\\begin\{(figure|table)\*?\}/.exec(src)?.[1] as Float['kind'] | undefined;
  if (!kind) return null;
  const text = live(src);
  let caption: Span | null = null;
  const cap = /\\caption\*?\s*(\[[^\]]*\])?\s*\{/.exec(text);
  if (cap) {
    const open = cap.index + cap[0].length - 1;
    const close = closeOf(text, open);
    if (close > 0) caption = span(src, open + 1, close - 1);
  }
  const graphics: Graphic[] = [];
  for (const m of text.matchAll(/\\includegraphics\*?/g)) {
    const commandEnd = m.index + m[0].length;
    let at = commandEnd;
    let optionsEnd = -1;
    let alt: Span | null = null;
    if (text[at] === '[') {
      const close = closeOf(text, at, '[', ']');
      if (close < 0) continue;
      optionsEnd = close - 1;
      // alt={...}, or alt=... up to the next comma.
      const key = /(^|,)\s*alt\s*=\s*/.exec(text.slice(at + 1, optionsEnd));
      if (key) {
        const value = at + 1 + key.index + key[0].length;
        if (text[value] === '{') {
          const end = closeOf(text, value);
          if (end > 0 && end <= optionsEnd) alt = span(src, value + 1, end - 1);
        } else {
          const comma = text.indexOf(',', value);
          alt = trimmed(src, value, comma < 0 || comma > optionsEnd ? optionsEnd : comma);
        }
      }
      at = close;
    }
    if (text[at] !== '{') continue;
    const close = closeOf(text, at);
    if (close < 0) continue;
    graphics.push({ target: trimmed(src, at + 1, close - 1), alt, optionsEnd, commandEnd });
  }
  return { kind, caption, graphics, table: tableOf(src, text) };
}

/** Replace `length` characters at `at` with `insert`. */
type Edit = { at: number; length: number; insert: string };

/**
 * The edit that gives a picture its description, or null if the text cannot be written into an
 * option as it is: it has a character that LaTeX would read as something else.
 */
export function altEdit(graphic: Graphic, text: string): Edit | null {
  const alt = text.replace(/\s+/g, ' ').trim();
  if (/[{}%#\\\]]/.test(alt)) return null;
  if (graphic.alt)
    return { at: graphic.alt.at, length: graphic.alt.end - graphic.alt.at, insert: alt };
  return graphic.optionsEnd >= 0
    ? { at: graphic.optionsEnd, length: 0, insert: `,alt={${alt}}` }
    : { at: graphic.commandEnd, length: 0, insert: `[alt={${alt}}]` };
}

/** Whether text can stand as one cell: no cell or row separator of its own, braces balanced. */
export function cellText(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      // \\\\ ends a row; any other backslash takes the next character with it (\\&, \\%).
      if (text[i + 1] === '\\') return false;
      i++;
    } else if (c === '{') depth++;
    else if (c === '}') {
      if (--depth < 0) return false;
    } else if (c === '\n' || c === '%') return false;
    else if (c === '&' && depth === 0) return false;
  }
  return depth === 0;
}
