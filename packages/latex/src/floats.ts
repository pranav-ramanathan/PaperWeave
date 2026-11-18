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
   * Each row as a stretch of the source: from the end of the row (or rule) before it to the end
   * of its own `\\`, if it has one. `indent` is the white space its line starts with.
   */
  lines: { at: number; end: number; terminated: boolean; indent: string }[];
  /** The column specification, inside its braces: `lrr`, `@{}lp{2cm}@{}`. */
  spec: Span;
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
  let spec = span(src, at, at);
  for (let groups = begin[1] === 'tabular' ? 1 : 2; groups > 0; groups--) {
    while (/\s/.test(text[at] ?? '')) at++;
    if (text[at] === '[') at = closeOf(text, at, '[', ']');
    const open = at;
    at = text[at] === '{' ? closeOf(text, at) : -1;
    if (at < 0) return null;
    spec = span(src, open + 1, at - 1);
  }
  const end = text.indexOf(`\\end{${begin[1]}}`, at);
  if (end < 0) return null;
  const body = text.slice(at, end);
  let simple = !/\\(multicolumn|multirow|begin)\b/.test(body);
  const rows: Span[][] = [];
  const lines: Table['lines'] = [];
  let row: Span[] = [];
  let cell = at;
  /** Where the row being read began: after the row or rule before it. */
  let rowAt = at;
  const closeCell = (to: number) => {
    const found = trimmed(src, cell, to);
    // An empty cell's place is where its text would go: with a space left on either side of it
    // when there is room, so that filling the cell does not run it into the next `&`.
    if (!found.text && to - cell >= 2) found.at = found.end = to - 1;
    row.push(found);
  };
  const closeRow = (to: number, terminated: boolean) => {
    // A last line with only rules on it, or nothing, is not a row.
    if (row.length > 1 || row[0]?.text) {
      rows.push(row);
      const lead = src.slice(rowAt, row[0].at);
      const indent = lead.includes('\n') ? lead.slice(lead.lastIndexOf('\n') + 1) : '';
      lines.push({ at: rowAt, end: to, terminated, indent: /^\s*$/.test(indent) ? indent : '' });
    }
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
        cell = rowAt = i;
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
      i += 2;
      // \\* and \\[2pt] are still just the end of a row.
      if (text[i] === '*') i++;
      if (text[i] === '[') i = closeOf(text, i, '[', ']');
      if (i < 0) return null;
      closeRow(i, true);
      cell = rowAt = i;
      i--;
    } else if (c === '\\') i++;
    else if (c === '&') {
      closeCell(i);
      cell = i + 1;
    }
  }
  closeCell(end);
  closeRow(row.at(-1)!.end, false);
  if (rows.some((r) => r.length !== rows[0].length)) simple = false;
  return { rows, lines, spec, simple };
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

export type TableOp =
  | { kind: 'row-after' | 'row-delete'; row: number }
  | { kind: 'column-after' | 'column-delete'; column: number };

/** The column-making letters of a specification, in order, or null if it is not that simple. */
function columnsOf(spec: Span): { at: number; end: number }[] | null {
  const out: { at: number; end: number }[] = [];
  const t = spec.text;
  for (let i = 0; i < t.length;) {
    const c = t[i];
    if (/\s|\|/.test(c)) i++;
    else if ('@!><'.includes(c)) {
      // A decoration with one argument: not a column.
      const close = t[i + 1] === '{' ? closeOf(t, i + 1) : -1;
      if (close < 0) return null;
      i = close;
    } else if ('lcrX'.includes(c)) {
      out.push({ at: spec.at + i, end: spec.at + i + 1 });
      i++;
    } else if ('pmb'.includes(c)) {
      const close = t[i + 1] === '{' ? closeOf(t, i + 1) : -1;
      if (close < 0) return null;
      out.push({ at: spec.at + i, end: spec.at + close });
      i = close;
    } else return null;
  }
  return out;
}

/**
 * The edit that adds or removes a row or a column of a simple table, or null if it cannot be
 * done here: the table would be left with nothing, or its column specification is of a kind
 * this does not take apart. The edit covers the stretch from the first change to the last.
 */
export function tableEdit(src: string, table: Table, op: TableOp): Edit | null {
  if (!table.simple || !table.rows.length) return null;
  const width = table.rows[0].length;
  if ('row' in op) {
    const line = table.lines[op.row];
    if (!line) return null;
    if (op.kind === 'row-delete')
      return table.rows.length < 2 ? null : { at: line.at, length: line.end - line.at, insert: '' };
    const indent = line.indent || table.lines.find((l) => l.indent)?.indent || '    ';
    const cells = Array.from({ length: width }, () => '').join(' & ');
    // A last row with no \\ of its own is given one before the new row follows it.
    const insert = line.terminated ? `\n${indent}${cells} \\\\` : ` \\\\\n${indent}${cells}`;
    return { at: line.end, length: 0, insert };
  }
  const columns = columnsOf(table.spec);
  const j = op.column;
  if (!columns || columns.length !== width || j < 0 || j >= width) return null;
  const splices: Edit[] = [];
  if (op.kind === 'column-after') {
    splices.push({ at: columns[j].end, length: 0, insert: 'l' });
    for (const row of table.rows) splices.push({ at: row[j].end, length: 0, insert: ' & ' });
  } else {
    if (width < 2) return null;
    splices.push({ at: columns[j].at, length: columns[j].end - columns[j].at, insert: '' });
    for (const row of table.rows) {
      // With the separator that goes with it: the one before, or for the first column the one after.
      const [from, to] = j ? [row[j - 1].end, row[j].end] : [row[0].at, row[1].at];
      splices.push({ at: from, length: to - from, insert: '' });
    }
  }
  splices.sort((a, b) => a.at - b.at);
  const at = splices[0].at;
  const end = Math.max(...splices.map((e) => e.at + e.length));
  let insert = src.slice(at, end);
  for (const e of [...splices].reverse())
    insert = insert.slice(0, e.at - at) + e.insert + insert.slice(e.at - at + e.length);
  return { at, length: end - at, insert };
}
