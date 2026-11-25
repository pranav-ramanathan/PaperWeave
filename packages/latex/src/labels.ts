// Labels and the references to them: where they are in the source, and what number LaTeX gave
// each label in a compiled build.
import { type Find, finder, groupEnds } from './scan.ts';

/** A `\label{key}`. Offsets are into the source text; `keyAt` is where the key itself starts. */
export type LabelDef = { key: string; at: number; end: number; keyAt: number };
/** One key inside a `\ref{...}` or one of its relatives. */
export type RefUse = { key: string; command: string; at: number; end: number; keyAt: number };

/** The commands that name a label, for parse and labelIndex alike. */
export const REFS = new Set([
  ...['ref', 'eqref', 'pageref', 'autoref', 'nameref', 'vref', 'Vref', 'vpageref', 'subref'],
  ...['cref', 'Cref', 'cpageref', 'Cpageref', 'namecref', 'crefrange', 'Crefrange', 'labelcref'],
  ...['fref', 'Fref', 'zcref', 'zcpageref', 'hyperref'],
  ...['cpagerefrange', 'Cpagerefrange', 'labelcpageref', 'nameCref', 'namecrefs', 'nameCrefs'],
  ...['lcnamecref', 'lcnamecrefs', 'vrefrange', 'vpagerefrange', 'autopageref', 'fullref'],
  ...['prettyref', 'thref'],
]);
/**
 * biblatex's multicites: `\\autocites(pre)(post)[pre][post]{keys}[pre][post]{keys}...`. Their keys
 * sit in several brace groups, which keyUses and the parser both read to the last one.
 */
export const MULTICITES = new Set([
  ...['cites', 'parencites', 'textcites', 'autocites', 'footcites', 'smartcites', 'supercites'],
  ...['Cites', 'Parencites', 'Textcites', 'Autocites'],
]);
/** The commands that name a bibliography key, for parse and citeIndex alike. */
export const CITES = new Set([
  ...['cite', 'citep', 'citet', 'citealt', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar'],
  ...['citenum', 'citetitle', 'nocite', 'parencite', 'textcite', 'autocite', 'footcite'],
  ...['smartcite', 'supercite', 'fullcite', 'footfullcite', 'Cite', 'Citep', 'Citet'],
  ...['Parencite', 'Textcite', 'Autocite', 'Citeauthor'],
  ...['Citealt', 'Citealp', 'citefullauthor', 'Citefullauthor', 'citetalias', 'citepalias'],
  ...['footcitetext', 'Smartcite', 'citeurl', 'citedate', 'shortcite', 'citeA', 'citeNP'],
  ...['citeN', 'shortciteA', 'shortciteNP', 'shortciteN', 'fullciteA', 'fullciteNP'],
  ...['citeyearNP', 'citeasnoun', 'possessivecite', 'citeposs'],
  ...MULTICITES,
]);
const VERBATIM = /^\\begin\{(verbatim\*?|lstlisting|minted|Verbatim|comment)\}/;

/** Commands whose first brace group is an address, written as it is. */
const VERBATIM_ARG = new Set(['url', 'nolinkurl', 'path', 'href']);
/**
 * Index after the `{...}` group at `at` (a `{`), braces balanced and nothing else special; 0 if
 * unclosed. `groupEnd` is `groupEnds` with no escapes: a group that never closes is paid for once.
 */
function verbatimGroup(groupEnd: (at: number) => number, at: number): number {
  return Math.max(0, groupEnd(at));
}

/** One key in the braces of a command: `\\ref{key}`, or one of several in `\\cite{a, b}`. */
type Use = { key: string; command: string; at: number; end: number; keyAt: number };

/** A walk that records every place it stood on only once it is longer than this many steps. */
const SHORT = 24;

/**
 * Where the key list that opens at `open` (a `{`) closes: the index of its `}`, or -1.
 *
 * Memo, exact: the walk takes the same steps wherever it begins (a `%` to the end of its line, a
 * backslash and the character after it, or one character) and carries nothing from one step to
 * the next, so the answer from a position is the same whichever walk stood there. Every walk
 * records its start with its own answer and, when longer than SHORT steps, every position it stood
 * on; a later walk that stands on one stops there. A `}` in a comment or after a backslash is
 * skipped by the same steps as before, so it does not count now either.
 */
function keyListEnds(src: string, find: Find): (open: number) => number {
  const n = src.length;
  const memo = new Map<number, number>();
  return (open) => {
    let k = open + 1;
    let steps = 0;
    let trail: number[] | undefined;
    let r = -1;
    while (k < n) {
      const m = memo.get(k);
      if (m !== undefined) {
        r = m;
        break;
      }
      if (++steps > SHORT) (trail ??= []).push(k);
      const c = src[k];
      if (c === '}') {
        r = k;
        break;
      }
      if (c === '%') {
        const nl = find('\n', k);
        k = nl < 0 ? n : nl + 1;
      } else k += c === '\\' ? 2 : 1;
    }
    memo.set(open + 1, r);
    if (trail) for (const p of trail) memo.set(p, r);
    return r;
  };
}

/**
 * The key list that opens at `open` (a `{`): where its `}` is, and its text with each comment
 * blanked to spaces, so offsets in it are offsets in the source. A `}` in a comment does not
 * close it. Null if it never closes. `ends` is `keyListEnds`: a list that never closes is paid
 * for once, and the text is built only for one that does (it is then read, and not again).
 */
function keyList(
  src: string,
  open: number,
  ends: (open: number) => number,
): { close: number; body: string } | null {
  if (ends(open) < 0) return null;
  let body = '';
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '}') return { close: i, body };
    if (c === '%') {
      while (i < src.length && src[i] !== '\n') {
        body += ' ';
        i++;
      }
      if (i < src.length) body += ' ';
      continue;
    }
    body += c;
    if (c === '\\' && i + 1 < src.length) body += src[++i];
  }
  return null;
}

/**
 * The `label=` given in the options of a listing, where `open` is the `[` that starts them: the
 * key and where it starts, and the `]` that ends the options. Only `close` if the options name no
 * usable key; null if they never end. The last `label=` wins, as in listings.
 */
function listingLabel(
  src: string,
  open: number,
  look: { find: Find; groupEnd: (at: number) => number },
): { key?: string; keyAt: number; close: number } | null {
  // The options end at a `]`; with none in the text after the `[` they never end.
  if (look.find(']', open + 1) < 0) return null;
  let depth = 0;
  let close = -1;
  const items: { from: number; to: number }[] = [];
  let from = open + 1;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '%') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && (c === ',' || c === ']')) {
      items.push({ from, to: i });
      from = i + 1;
      if (c === ']') {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  let found: { key: string; keyAt: number } | null = null;
  for (const { from: a, to: b } of items) {
    // Comments are dropped from the item by blanking them, so offsets stay offsets in the source.
    let text = src.slice(a, b);
    text = text.replace(/%[^\n]*/g, (m) => ' '.repeat(m.length));
    const head = /^\s*label\s*=\s*/.exec(text);
    if (!head) continue;
    let valueAt = a + head[0].length;
    let value = text.slice(head[0].length);
    if (value.startsWith('{')) {
      const end = verbatimGroup(look.groupEnd, valueAt);
      if (!end || end > b) {
        found = null;
        continue;
      }
      value = src.slice(valueAt + 1, end - 1);
      valueAt += 1;
    }
    const key = value.trim();
    const keyAt = valueAt + value.indexOf(key);
    found =
      key && !/[#\\{},%]/.test(key) && src.slice(keyAt, keyAt + key.length) === key
        ? { key, keyAt }
        : null;
  }
  return found ? { ...found, close } : { keyAt: -1, close };
}

/**
 * Every key given to the commands `wanted` names, with where it is. Comments and verbatim text
 * are skipped. A key built from a macro argument (`\\label{fig:#1}`) is not a key and is left out.
 */
function keyUses(src: string, wanted: (command: string) => boolean): Use[] {
  const out: Use[] = [];
  // Every look-ahead below is a pure function of `src`, so one that failed is not paid for by the
  // next opener: see `finder`, `groupEnds` and `keyListEnds` for why each is exact.
  const find = finder(src);
  const look = { find, groupEnd: groupEnds(src, { escapes: false }) };
  const listEnds = keyListEnds(src, find);
  /** After spaces, and one line break if no blank line follows it: where TeX looks next. */
  const skipWs = (k: number) => {
    while (src[k] === ' ' || src[k] === '\t') k++;
    if (src[k] === '\n') {
      let m = k + 1;
      while (src[m] === ' ' || src[m] === '\t') m++;
      if (m < src.length && src[m] !== '\n') return m;
    }
    return k;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '%') {
      // A comment runs to the end of its line.
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c !== '\\') continue;
    const verbatim = VERBATIM.exec(src.slice(i, i + 24));
    if (verbatim) {
      if (verbatim[1] === 'lstlisting' && wanted('label')) {
        let o = i + verbatim[0].length;
        while (src[o] === ' ' || src[o] === '\t') o++;
        const opts = src[o] === '[' ? listingLabel(src, o, look) : null;
        if (opts && opts.key !== undefined)
          out.push({
            key: opts.key,
            command: 'label',
            at: i,
            end: opts.close + 1,
            keyAt: opts.keyAt,
          });
      }
      const close = find(`\\end{${verbatim[1]}}`, i);
      i = close < 0 ? src.length : close;
      continue;
    }
    const name = /^\\([a-zA-Z]+)\*?/.exec(src.slice(i, i + 24));
    if (!name) {
      // An escaped character, such as \% or \\: never the start of anything here.
      i++;
      continue;
    }
    let p = i + name[0].length;
    if (name[1] === 'verb') {
      // (At the end of the text `src[p]` is undefined, and indexOf looks for "undefined".)
      const close = find(String(src[p]), p + 1);
      i = close < 0 ? src.length : close;
      continue;
    }
    if (name[1] === 'lstinline' || name[1] === 'mintinline') {
      // \lstinline[opts]|code|, \lstinline{code}, \mintinline{lang}|code|: no comments, no keys.
      if (src[p] === '[') p = find(']', p) + 1 || src.length;
      if (name[1] === 'mintinline' && src[p] === '{') p = find('}', p) + 1 || src.length;
      const open = src[p];
      if (open === '{') {
        i = (verbatimGroup(look.groupEnd, p) || src.length) - 1;
        continue;
      }
      if (open !== undefined && !/[\s\w]/.test(open)) {
        const close = find(open, p + 1);
        const nl = find('\n', p);
        i = close >= 0 && (nl < 0 || close < nl) ? close : (nl < 0 ? src.length : nl) - 1;
        continue;
      }
    }
    if (VERBATIM_ARG.has(name[1]) && src[p] === '{') {
      // The address of \url{..} or \href{..}{..} is taken as it is: a % in it is no comment.
      const end = verbatimGroup(look.groupEnd, p);
      if (end) {
        i = end - 1;
        continue;
      }
    }
    if (name[1] === 'lstinputlisting' && wanted('label')) {
      const o = skipWs(p);
      const opts = src[o] === '[' ? listingLabel(src, o, look) : null;
      if (opts) {
        if (opts.key !== undefined)
          out.push({
            key: opts.key,
            command: 'label',
            at: i,
            end: opts.close + 1,
            keyAt: opts.keyAt,
          });
        i = opts.close;
        continue;
      }
    }
    if (!wanted(name[1])) {
      i = p - 1;
      continue;
    }
    if (name[1] === 'hyperref') {
      // \\hyperref[key]{text}: the key is the optional argument. \\hyperref{url}{..}{..}{text} names none.
      p = skipWs(p);
      const close = src[p] === '[' ? find(']', p) : -1;
      if (close > 0) {
        const key = src.slice(p + 1, close).trim();
        if (key && !/[#\\{,]/.test(key))
          out.push({
            key,
            command: 'hyperref',
            at: i,
            end: close + 1,
            keyAt: p + 1 + src.slice(p + 1).indexOf(key),
          });
      }
      i = (close > 0 ? close : p) - 1;
      continue;
    }
    // Optional arguments come first: \\cref[x]{..}, \\citep[see][p.~3]{..}. A multicite repeats
    // `[pre][post]{keys}` after global `(pre)(post)` notes; \\cite<pre>{..} has an angle note.
    const multi = MULTICITES.has(name[1]);
    const cite = CITES.has(name[1]);
    for (let unit = 0; unit === 0 || multi; unit++) {
      const before = p;
      let u = p;
      if (multi && unit === 0)
        for (;;) {
          u = skipWs(u);
          const close = src[u] === '(' ? find(')', u) : -1;
          if (close < 0) break;
          u = close + 1;
        }
      u = skipWs(u);
      if (cite && src[u] === '<' && find('>', u) > 0) u = find('>', u) + 1;
      for (;;) {
        u = skipWs(u);
        if (src[u] !== '[') break;
        u = find(']', u) + 1 || src.length;
      }
      // A later unit that is not a whole `[..]{..}` is not part of the citation.
      if (unit > 0 && src[u] !== '{') break;
      // crefrange takes two groups; everything else one.
      for (let group = 0; group < (name[1].endsWith('range') ? 2 : 1); group++) {
        if (group > 0) u = skipWs(u);
        if (src[u] !== '{') break;
        const list = keyList(src, u, listEnds);
        if (!list) break;
        const { close } = list;
        let keyAt = u + 1;
        for (const part of list.body.split(',')) {
          const key = part.trim();
          const at = keyAt + part.indexOf(key);
          keyAt += part.length + 1;
          if (!key || /[#\\{]/.test(key) || src.slice(at, at + key.length) !== key) continue;
          out.push({ key, command: name[1], at: i, end: close + 1, keyAt: at });
        }
        u = close + 1;
      }
      p = u;
      // A later unit that stands where the one before did asks the same again, for ever: an
      // unclosed `\cites{` hung this loop. It adds nothing, so it ends here.
      if (unit > 0 && u === before) break;
    }
    i = p - 1;
  }
  return out;
}

/** Every label defined and every reference made in a piece of LaTeX. */
export function labelIndex(src: string): { labels: LabelDef[]; refs: RefUse[] } {
  const uses = keyUses(src, (name) => name === 'label' || REFS.has(name));
  return {
    labels: uses
      .filter((u) => u.command === 'label')
      .map(({ key, at, end, keyAt }) => ({ key, at, end, keyAt })),
    refs: uses.filter((u) => u.command !== 'label'),
  };
}

/** One key in a `\\cite{...}` or one of its relatives. `\\nocite{*}` names no key. */
export type CiteUse = Use;
export function citeIndex(src: string): CiteUse[] {
  return keyUses(src, (name) => CITES.has(name)).filter((u) => u.key !== '*');
}

/** The first `{...}` group at `at`, braces balanced, without its outer braces. */
function group(text: string, at: number): { body: string; end: number } | null {
  if (text[at] !== '{') return null;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return { body: text.slice(at + 1, i), end: i + 1 };
  }
  return null;
}
/** What a number looks like on the page: without the macros and braces LaTeX wraps it in. */
const plain = (tex: string) =>
  tex
    .replace(/\\[a-zA-Z@]+ ?/g, '')
    .replace(/[{}]/g, '')
    .trim();

/**
 * The number and page LaTeX gave each label, read from a build's .aux files. This is what `\ref`
 * prints in the PDF of that build.
 */
export function auxLabels(aux: string): Record<string, { number: string; page: string }> {
  const out: Record<string, { number: string; page: string }> = {};
  for (const m of aux.matchAll(/\\newlabel\{/g)) {
    const key = group(aux, m.index + m[0].length - 1);
    const value = key && group(aux, key.end);
    const number = value && group(value.body, 0);
    const page = number && group(value.body, number.end);
    // cleveref keeps a second entry per label, for its own use.
    if (!key || !number || key.body.endsWith('@cref')) continue;
    out[key.body] = { number: plain(number.body), page: page ? plain(page.body) : '' };
  }
  return out;
}
