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
  /** The description is written without braces: `alt=text`. */
  altBare: boolean;
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
    /((?:^|[^\\])(?:\\\\)*)%.*$/gm,
    (all, before: string) => before + ' '.repeat(all.length - before.length),
  );
const span = (src: string, at: number, end: number): Span => ({
  text: src.slice(at, end),
  at,
  end,
});
/** The span with the white space at both ends left out, as `by` (default `src`) sees it. */
function trimmed(src: string, at: number, end: number, by = src): Span {
  while (at < end && /\s/.test(by[at])) at++;
  while (end > at && /\s/.test(by[end - 1])) end--;
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
    // Where the cell's own text may begin: after any comment lines at its start.
    let from = cell;
    for (let k = cell; k < to; k++) {
      if (src[k] === '%' && text[k] === ' ') {
        const nl = src.indexOf('\n', k);
        if (nl < 0 || nl >= to) break;
        from = k = nl;
        from++;
      } else if (!/\s/.test(text[k])) break;
    }
    // Comments are blanked in `text`, so trimming by it leaves them out of the ends of the cell.
    const found = trimmed(src, from, to, text);
    // An empty cell's place is where its text would go: with a space left on either side of it
    // when there is room, so that filling the cell does not run it into the next `&`.
    if (!found.text && to - from >= 2) found.at = found.end = to - 1;
    // A comment inside the cell cannot be shown as the cell's text.
    if (found.text !== text.slice(found.at, found.end)) simple = false;
    // Comment lines above a row are not part of its line.
    if (!row.length && from > cell) rowAt = from - 1;
    row.push(found);
  };
  const closeRow = (to: number, terminated: boolean) => {
    // A last line with only rules on it, or nothing, is not a row; a line with only \\ is.
    if (row.length > 1 || row[0]?.text || terminated) {
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
      // A comment on the row's own line goes with the row.
      let j = i;
      while (src[j] === ' ' || src[j] === '\t') j++;
      if (src[j] === '%') {
        const nl = src.indexOf('\n', j);
        i = nl < 0 || nl > end ? end : nl;
      }
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
    let altBare = false;
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
          altBare = true;
        }
      }
      at = close;
    }
    if (text[at] !== '{') continue;
    const close = closeOf(text, at);
    if (close < 0) continue;
    graphics.push({
      target: trimmed(src, at + 1, close - 1),
      alt,
      altBare,
      optionsEnd,
      commandEnd,
    });
  }
  return { kind, caption, graphics, table: tableOf(src, text) };
}

/**
 * A part's text as one line, for a field that cannot hold a line break, or null if it cannot be
 * one without losing something: a comment with words in it, or a blank line.
 */
export function fieldText(latex: string): string | null {
  // A bare comment mark at the end of a line only joins it to the next.
  const joined = latex.replace(
    /((?:^|[^\\])(?:\\\\)*)%[ \t]*(?:\n[ \t]*|$)/g,
    (_, before: string) => before,
  );
  if (/(^|[^\\])(\\\\)*%/.test(joined)) return null;
  if (/\n[ \t]*\n/.test(joined)) return null;
  return joined.replace(/[ \t]*\n[ \t]*/g, ' ').trim();
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
  if (graphic.alt) {
    // Without braces a comma ends the value and an equals sign starts a new key.
    const insert = graphic.altBare && /[,=]/.test(alt) ? `{${alt}}` : alt;
    return { at: graphic.alt.at, length: graphic.alt.end - graphic.alt.at, insert };
  }
  return graphic.optionsEnd >= 0
    ? { at: graphic.optionsEnd, length: 0, insert: `,alt={${alt}}` }
    : { at: graphic.commandEnd, length: 0, insert: `[alt={${alt}}]` };
}

/**
 * Whether text can stand inside braces without breaking what is around it. In a cell a `\\` ends
 * the row, so it is refused there; elsewhere it is a line break.
 */
function fits(text: string, cell: boolean): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      // A backslash at the end would take the closing brace with it.
      if (i === text.length - 1) return false;
      // \\\\ ends a row; any other backslash takes the next character with it (\\&, \\%).
      if (text[i + 1] === '\\' && cell) return false;
      i++;
    } else if (c === '{') depth++;
    else if (c === '}') {
      if (--depth < 0) return false;
    } else if (c === '\n' || c === '%') return false;
    else if (c === '&' && depth === 0) return false;
  }
  return depth === 0;
}

/** Whether text can stand as one cell: no cell or row separator of its own, braces balanced. */
export const cellText = (text: string): boolean => fits(text, true);

/**
 * Whether text can stand as a caption's argument: braces balanced, no bare % or &, no line
 * break, not ending in a lone backslash. A `\\\\` is allowed.
 */
export const captionText = (text: string): boolean => fits(text, false);

/** Commands whose braces hold text that is set as it is typed, so that marks in it still count. */
const TEXT_COMMANDS = new Set(
  (
    'textbf textit emph texttt textsc textsf textrm textmd textup textsl textnormal underline ' +
    'mbox footnote multicolumn multirow makecell caption textcolor text'
  ).split(' '),
);

/**
 * The first mark in text that TeX would stop at: `_` or `^` outside a formula, `#` anywhere, or
 * a `$` that opens a formula and never closes it. Null if there is none. Marks inside the
 * argument of a command this does not know are not looked at.
 */
export function stray(text: string): '_' | '^' | '#' | '$' | null {
  return marks(text, false) as '_' | '^' | '#' | '$' | null;
}
function marks(text: string, amp: boolean): '_' | '^' | '#' | '$' | '&' | null {
  if (/\\(?:verb|lstinline|mintinline|path)(?![a-zA-Z])/.test(text)) return null;
  // One entry per open group: whether maths was on when it opened.
  const groups: { maths: boolean; text: boolean }[] = [];
  let maths = false;
  // Maths opened by `$$`.
  let display = false;
  // True just after a text command, so that the groups that follow it are read as text.
  let argument = false;
  // The offset just past an argument that opens at `from`, or `from` itself if there is none.
  const skip = (from: number): number => {
    let i = from;
    for (;;) {
      if (text[i] === '[') {
        let depth = 0;
        let j = i + 1;
        for (; j < text.length; j++) {
          if (text[j] === '\\') j++;
          else if (text[j] === '{') depth++;
          else if (text[j] === '}') depth--;
          else if (text[j] === ']' && depth === 0) break;
        }
        if (j >= text.length) return i;
        i = j + 1;
      } else if (text[i] === '{') {
        const close = closeOf(text, i);
        if (close < 0) return text.length;
        i = close;
      } else return i;
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[' && argument) {
      i = skip(i) - 1;
      continue;
    }
    const keep = argument && c === '{';
    if (!keep && !/\s/.test(c)) argument = false;
    if (c === '\\') {
      const next = text[i + 1] ?? '';
      if (!/[a-zA-Z]/.test(next)) {
        i++;
        if (next === '(' || next === '[') {
          if (maths) return '$';
          maths = true;
        } else if (next === ')' || next === ']') {
          if (!maths) return '$';
          maths = false;
        }
        continue;
      }
      let j = i + 1;
      while (/[a-zA-Z]/.test(text[j] ?? '')) j++;
      const name = text.slice(i + 1, j);
      if (text[j] === '*') j++;
      if (TEXT_COMMANDS.has(name)) {
        argument = true;
        i = j - 1;
      } else i = skip(j) - 1;
    } else if (c === '{') {
      groups.push({ maths, text: keep });
      // Maths is off inside the argument of a text command; it comes back at its `}`.
      if (keep) maths = false;
    } else if (c === '}') {
      const group = groups.pop();
      if (group) {
        // Maths opened inside the group and never closed.
        if (maths && !group.maths) return '$';
        maths = group.maths;
        // Another argument right after, as in \multicolumn{2}{c}{...}.
        if (group.text && text[i + 1] === '{') argument = true;
      }
    } else if (c === '$') {
      // `$$` opens and closes display maths, which a single `$` does not end.
      if (!maths) {
        maths = true;
        display = text[i + 1] === '$';
        if (display) i++;
      } else if (!display) maths = false;
      else if (text[i + 1] === '$') {
        maths = display = false;
        i++;
      }
    } else if (c === '#') return '#';
    else if (c === '&' && amp) return '&';
    else if ((c === '_' || c === '^') && !maths) return c;
  }
  return maths ? '$' : null;
}

/** What to tell someone whose text holds a mark `stray` found. Never quotes what they typed. */
export function strayAdvice(kind: '_' | '^' | '#' | '$' | '&'): string {
  switch (kind) {
    case '_':
      return 'An underscore outside a formula stops the build. Write \\_ for an underscore, or put the formula between $ signs.';
    case '^':
      return 'A ^ outside a formula stops the build. Put the formula between $ signs, or write \\textasciicircum{} for the sign itself.';
    case '#':
      return 'A # stops the build. Write \\# for the sign.';
    case '$':
      return 'A $ starts a formula, and this one does not end. Write \\$ for a dollar sign.';
    case '&':
      return 'An & outside a table stops the build. Write \\& for the sign.';
  }
}

const ENV_ADVICE =
  'A \\begin here has no matching \\end, or the other way round. Close it inside this text, or make the change in the source.';

/** The first thing in `t` that would stop the build: a mark, or an environment left unbalanced. */
function find(t: string): '_' | '^' | '#' | '$' | '&' | 'env' | null {
  const hit = marks(t, !t.includes('\\begin{'));
  if (hit) return hit;
  if (/\\(?:verb|lstinline|mintinline|path)(?![a-zA-Z])/.test(t)) return null;
  const open: string[] = [];
  for (const m of t.matchAll(/\\(begin|end)\s*\{([^{}]*)\}/g)) {
    if (m[1] === 'begin') open.push(m[2]);
    else if (open.pop() !== m[2]) return 'env';
  }
  return open.length ? 'env' : null;
}

/**
 * What to tell someone whose new text for an atom (a footnote, a text command) would stop the
 * build, or null. Text that already had the problem is not held to it. Never quotes the text.
 */
export function atomProblem(text: string, was: string): string | null {
  const kind = find(text);
  if (!kind || find(was)) return null;
  return kind === 'env' ? ENV_ADVICE : strayAdvice(kind);
}

/**
 * What a new footnote will hold, from what was typed for it (words, or LaTeX as in "Edit
 * footnote"), or what to tell the person if it would stop the build. Whether it is read as one
 * footnote where it is put is the bridge's to say (`footnoteCommand`). Never quotes the text.
 */
export function footnoteBody(typed: string): { text: string } | { problem: string } {
  // One paragraph: a line break is a space, and a blank line would end the paragraph it is in.
  const text = typed.replace(/\s+/g, ' ').trim();
  if (!text) return { problem: 'A footnote needs some text.' };
  if (!captionText(text))
    return {
      problem:
        'A footnote cannot hold an unescaped % or &, its braces must match, and it cannot end in a backslash. Write \\% for a percent sign and \\& for an ampersand.',
    };
  // In an argument a # stops the build wherever it is, an address in \url included.
  if (/(?<!\\)(?:\\\\)*#/.test(text)) return { problem: strayAdvice('#') };
  if (/\\(?:verb|lstinline|mintinline)(?![a-zA-Z])/.test(text))
    return { problem: 'A footnote cannot hold \\verb. Write \\texttt{...} for text set as code.' };
  const stops = atomProblem(`\\footnote{${text}}`, '');
  return stops ? { problem: stops } : { text };
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
    // With one column an empty last row is nothing to read, so the new row ends with its own too.
    const insert = line.terminated
      ? `\n${indent}${cells} \\\\`
      : ` \\\\\n${indent}${cells}${width < 2 ? ' \\\\' : ''}`;
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
