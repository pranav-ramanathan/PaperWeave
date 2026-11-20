// Labels and the references to them: where they are in the source, and what number LaTeX gave
// each label in a compiled build.

/** A `\label{key}`. Offsets are into the source text; `keyAt` is where the key itself starts. */
export type LabelDef = { key: string; at: number; end: number; keyAt: number };
/** One key inside a `\ref{...}` or one of its relatives. */
export type RefUse = { key: string; command: string; at: number; end: number; keyAt: number };

const REFS = new Set([
  ...['ref', 'eqref', 'pageref', 'autoref', 'nameref', 'vref', 'Vref', 'vpageref', 'subref'],
  ...['cref', 'Cref', 'cpageref', 'Cpageref', 'namecref', 'crefrange', 'Crefrange', 'labelcref'],
  ...['fref', 'Fref', 'zcref', 'zcpageref', 'hyperref'],
]);
const CITES = new Set([
  ...['cite', 'citep', 'citet', 'citealt', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar'],
  ...['citenum', 'citetitle', 'nocite', 'parencite', 'textcite', 'autocite', 'footcite'],
  ...['smartcite', 'supercite', 'fullcite', 'footfullcite', 'Cite', 'Citep', 'Citet'],
  ...['Parencite', 'Textcite', 'Autocite', 'Citeauthor'],
]);
const VERBATIM = /^\\begin\{(verbatim\*?|lstlisting|minted|Verbatim|comment)\}/;

/** One key in the braces of a command: `\\ref{key}`, or one of several in `\\cite{a, b}`. */
type Use = { key: string; command: string; at: number; end: number; keyAt: number };

/**
 * Every key given to the commands `wanted` names, with where it is. Comments and verbatim text
 * are skipped. A key built from a macro argument (`\\label{fig:#1}`) is not a key and is left out.
 */
function keyUses(src: string, wanted: (command: string) => boolean): Use[] {
  const out: Use[] = [];
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
    if (!wanted(name[1])) {
      i = p - 1;
      continue;
    }
    if (name[1] === 'hyperref') {
      // \\hyperref[key]{text}: the key is the optional argument. \\hyperref{url}{..}{..}{text} names none.
      while (src[p] === ' ') p++;
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
    // Optional arguments come first: \cref[x]{..}, \citep[see][p.~3]{..}.
    for (;;) {
      while (src[p] === ' ') p++;
      if (src[p] !== '[') break;
      p = src.indexOf(']', p) + 1 || src.length;
    }
    // crefrange takes two groups; everything else one.
    for (let group = 0; group < (name[1].endsWith('range') ? 2 : 1) && src[p] === '{'; group++) {
      const close = src.indexOf('}', p);
      if (close < 0) break;
      let keyAt = p + 1;
      for (const part of src.slice(p + 1, close).split(',')) {
        const key = part.trim();
        const at = keyAt + part.indexOf(key);
        keyAt += part.length + 1;
        if (!key || /[#\\{]/.test(key)) continue;
        out.push({ key, command: name[1], at: i, end: close + 1, keyAt: at });
      }
      p = close + 1;
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
