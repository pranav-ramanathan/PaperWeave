// Labels and the references to them: where they are in the source, and what number LaTeX gave
// each label in a compiled build.

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
/** Index after the `{...}` group at `at`, braces balanced and nothing else special; 0 if unclosed. */
function verbatimGroup(src: string, at: number): number {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i + 1;
  }
  return 0;
}

/** One key in the braces of a command: `\\ref{key}`, or one of several in `\\cite{a, b}`. */
type Use = { key: string; command: string; at: number; end: number; keyAt: number };

/**
 * The key list that opens at `open` (a `{`): where its `}` is, and its text with each comment
 * blanked to spaces, so offsets in it are offsets in the source. A `}` in a comment does not
 * close it. Null if it never closes.
 */
function keyList(src: string, open: number): { close: number; body: string } | null {
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
 * Every key given to the commands `wanted` names, with where it is. Comments and verbatim text
 * are skipped. A key built from a macro argument (`\\label{fig:#1}`) is not a key and is left out.
 */
function keyUses(src: string, wanted: (command: string) => boolean): Use[] {
  const out: Use[] = [];
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
      const close = src.indexOf(`\\end{${verbatim[1]}}`, i);
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
      const close = src.indexOf(src[p], p + 1);
      i = close < 0 ? src.length : close;
      continue;
    }
    if (name[1] === 'lstinline' || name[1] === 'mintinline') {
      // \lstinline[opts]|code|, \lstinline{code}, \mintinline{lang}|code|: no comments, no keys.
      if (src[p] === '[') p = src.indexOf(']', p) + 1 || src.length;
      if (name[1] === 'mintinline' && src[p] === '{') p = src.indexOf('}', p) + 1 || src.length;
      const open = src[p];
      if (open === '{') {
        i = (verbatimGroup(src, p) || src.length) - 1;
        continue;
      }
      if (open !== undefined && !/[\s\w]/.test(open)) {
        const close = src.indexOf(open, p + 1);
        const nl = src.indexOf('\n', p);
        i = close >= 0 && (nl < 0 || close < nl) ? close : (nl < 0 ? src.length : nl) - 1;
        continue;
      }
    }
    if (VERBATIM_ARG.has(name[1]) && src[p] === '{') {
      // The address of \url{..} or \href{..}{..} is taken as it is: a % in it is no comment.
      const end = verbatimGroup(src, p);
      if (end) {
        i = end - 1;
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
      const close = src[p] === '[' ? src.indexOf(']', p) : -1;
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
      let u = p;
      if (multi && unit === 0)
        for (;;) {
          u = skipWs(u);
          const close = src[u] === '(' ? src.indexOf(')', u) : -1;
          if (close < 0) break;
          u = close + 1;
        }
      u = skipWs(u);
      if (cite && src[u] === '<' && src.indexOf('>', u) > 0) u = src.indexOf('>', u) + 1;
      for (;;) {
        u = skipWs(u);
        if (src[u] !== '[') break;
        u = src.indexOf(']', u) + 1 || src.length;
      }
      // A later unit that is not a whole `[..]{..}` is not part of the citation.
      if (unit > 0 && src[u] !== '{') break;
      // crefrange takes two groups; everything else one.
      for (let group = 0; group < (name[1].endsWith('range') ? 2 : 1); group++) {
        if (group > 0) u = skipWs(u);
        if (src[u] !== '{') break;
        const list = keyList(src, u);
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
