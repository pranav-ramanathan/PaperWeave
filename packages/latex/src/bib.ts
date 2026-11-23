// A reading of a BibTeX file: its entries, by key, and where each is. The file is never
// rewritten from this: it is an index, and the bytes stay as their author left them.

export type BibEntry = {
  key: string;
  /** Lower case: article, inproceedings, book... */
  type: string;
  /** Field name (lower case) to its value, outer braces or quotes removed. */
  fields: Record<string, string>;
  /** Where the entry starts (its @), where it ends, and where its key starts. */
  at: number;
  end: number;
  keyAt: number;
};

/** The offset just past the group that opens at `at` with `{` or `(`, or the end of the text. */
function closeOf(text: string, at: number) {
  const [open, close] = text[at] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === open || text[i] === '{') depth++;
    else if ((text[i] === close || text[i] === '}') && --depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * Every entry of a .bib file, in order. Text between entries is commentary to BibTeX and is
 * skipped, as are @comment, @preamble and @string. A broken entry ends where the file does.
 */
export function bibEntries(text: string): BibEntry[] {
  const out: BibEntry[] = [];
  const START = /@([a-zA-Z]+)\s*[{(]/g;
  for (let m = START.exec(text); m; m = START.exec(text)) {
    const type = m[1].toLowerCase();
    const open = m.index + m[0].length - 1;
    const end = closeOf(text, open);
    START.lastIndex = end;
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
    const body = text.slice(open + 1, end - 1);
    const comma = body.indexOf(',');
    const rawKey = comma < 0 ? body : body.slice(0, comma);
    const key = rawKey.trim();
    if (!key || /[\s{}"=]/.test(key)) continue;
    const fields: Record<string, string> = {};
    // Fields: name = value, where a value is braced, quoted or bare, and may be joined with #.
    for (let i = comma < 0 ? body.length : comma + 1; i < body.length;) {
      const name = /\s*([a-zA-Z][\w:-]*)\s*=\s*/y;
      name.lastIndex = i;
      const field = name.exec(body);
      if (!field) {
        i++;
        continue;
      }
      i = name.lastIndex;
      const parts: string[] = [];
      for (;;) {
        while (/\s/.test(body[i] ?? '')) i++;
        if (body[i] === '{') {
          const close = closeOf(body, i);
          parts.push(body.slice(i + 1, close - 1));
          i = close;
        } else if (body[i] === '"') {
          let j = i + 1;
          for (let depth = 0; j < body.length && (body[j] !== '"' || depth > 0); j++) {
            if (body[j] === '\\') j++;
            else if (body[j] === '{') depth++;
            else if (body[j] === '}') depth--;
          }
          parts.push(body.slice(i + 1, j));
          i = j + 1;
        } else {
          const bare = /[^\s,#]*/y;
          bare.lastIndex = i;
          parts.push(bare.exec(body)![0]);
          i = bare.lastIndex;
        }
        while (/\s/.test(body[i] ?? '')) i++;
        if (body[i] !== '#') break;
        i++;
      }
      // The first of a repeated field is the one BibTeX keeps.
      fields[field[1].toLowerCase()] ??= parts.join('').replace(/\s+/g, ' ').trim();
      if (body[i] === ',') i++;
    }
    out.push({ key, type, fields, at: m.index, end, keyAt: open + 1 + rawKey.indexOf(key) });
  }
  return out;
}

/**
 * Where an entry holds a character TeX cannot take bare (`_`, `&`, `#`, `^`): the first such
 * line, as a line of the whole file, with the field it is in. A `\x` pair and a `$...$` span
 * are fine, and so is a field in `skip`. A value that runs over several lines keeps its field.
 */
export function bareIn(
  text: string,
  entry: BibEntry,
  chars: string,
  skip: readonly string[],
): { line: number; field: string; char: string } | undefined {
  const first = text.slice(0, entry.at).split('\n').length;
  const lines = text.slice(entry.at, entry.end).split('\n');
  let field = '';
  // The first line is `@type{key,`: nothing of the author's text.
  for (let i = 1; i < lines.length; i++) {
    let line = lines[i];
    const name = /^\s*([a-zA-Z][\w:-]*)\s*=/.exec(line);
    if (name) {
      field = name[1].toLowerCase();
      line = line.slice(name[0].length);
    }
    if (skip.includes(field)) continue;
    const bare = line.replace(/\\./g, '  ').replace(/\$[^$]*\$/g, (m) => ' '.repeat(m.length));
    const char = [...chars].find((c) => bare.includes(c));
    if (char) return { line: first + i, field, char };
  }
  return undefined;
}

export const LIGATURES: Record<string, string> = {
  oe: 'œ',
  OE: 'Œ',
  ae: 'æ',
  AE: 'Æ',
  aa: 'å',
  AA: 'Å',
  ss: 'ß',
  o: 'ø',
  O: 'Ø',
  l: 'ł',
  L: 'Ł',
  i: 'i',
  j: 'j',
  dh: 'ð',
  DH: 'Ð',
  th: 'þ',
  TH: 'Þ',
  // The logos and a few names TeX writes with a macro.
  TeX: 'TeX',
  LaTeX: 'LaTeX',
  LaTeXe: 'LaTeX2e',
  BibTeX: 'BibTeX',
  XeTeX: 'XeTeX',
  LuaTeX: 'LuaTeX',
  ldots: '…',
  dots: '…',
  textendash: '–',
  textemdash: '—',
  textellipsis: '…',
  slash: '/',
  thinspace: '\u2009',
  copyright: '©',
  textcopyright: '©',
  textregistered: '®',
  texttrademark: '™',
  textdegree: '°',
  texteuro: '€',
  pounds: '£',
  textsterling: '£',
};

const LOGO = /^\\(TeX|LaTeX|LaTeXe|BibTeX|XeTeX|LuaTeX)(?:\{\})?$/;
/** What a logo command, written exactly as `\LaTeX` or `\LaTeX{}`, prints; null for anything else. */
export function logoOf(src: string): string | null {
  const m = LOGO.exec(src);
  return m ? LIGATURES[m[1]!]! : null;
}

/** An accent command and the combining mark it puts on the letter after it. */
const ACCENTS: Record<string, string> = {
  '`': '̀',
  "'": '́',
  '^': '̂',
  '~': '̃',
  '=': '̄',
  u: '̆',
  '.': '̇',
  '"': '̈',
  r: '̊',
  H: '̋',
  v: '̌',
  d: '̣',
  c: '̧',
  k: '̨',
  b: '̱',
  t: '',
};
export const accented = (accent: string, letter: string) =>
  (letter.replace(/^\\/, '') + ACCENTS[accent]).normalize('NFC');

/** A field's text as a person reads it: TeX accents, commands and braces taken away. */
export function plainText(tex: string) {
  return (
    tex
      // \"o, \"{o}, \'{\i}: a symbol accent, then a letter, bare or braced.
      .replace(/\\([`'^"~=.])\s*(?:\{\s*(\\[ij]|[a-zA-Z])\s*\}|(\\[ij]|[a-zA-Z]))/g, (_, a, l, m) =>
        accented(a, l ?? m),
      )
      // \c{c}, \c c, \H{o}, \v{s}: a letter accent needs its braces or a space.
      .replace(/\\([uvHtcdbkr])(?:\s*\{\s*(\\[ij]|[a-zA-Z])\s*\}|\s+([a-zA-Z]))/g, (_, a, l, m) =>
        accented(a, l ?? m),
      )
      .replace(/\\([&%$#_])/g, '$1')
      .replace(/\\([a-zA-Z]+)(?![a-zA-Z])\s*(?:\{\})?/g, (all, name: string) =>
        // A name that is not known is dropped; whatever follows it stays.
        Object.hasOwn(LIGATURES, name) ? LIGATURES[name]! : '',
      )
      .replace(/[{}]/g, '')
      .replace(/~/g, ' ')
      .replace(/--+/g, '–')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** One line that says what an entry is: "Shapiro et al. 2011. Conflict-Free Replicated Data Types". */
export function describeEntry(entry: BibEntry) {
  const people = (entry.fields.author ?? entry.fields.editor ?? '')
    .split(/\s+and\s+/i)
    .map((p) => plainText(p))
    .filter(Boolean)
    // "Family, Given" or "Given Family".
    .map((p) => (p.includes(',') ? p.slice(0, p.indexOf(',')) : p.split(' ').at(-1)!));
  const who = people.length > 2 ? `${people[0]} et al.` : people.length ? people.join(' and ') : '';
  const year = /\d{4}/.exec(entry.fields.year ?? entry.fields.date ?? '')?.[0] ?? '';
  const title = plainText(entry.fields.title ?? '');
  const lead = [who, year].filter(Boolean).join(' ');
  // "Shapiro et al." already ends in a full stop.
  return [lead, title].filter(Boolean).join(lead.endsWith('.') ? ' ' : '. ') || entry.key;
}

/** An entry of a hand-written `thebibliography`: `\bibitem[label]{key} text`. */
export type BibItem = {
  key: string;
  /** The item's text up to the next `\bibitem` or `\end{thebibliography}`, on one line. */
  text: string;
  /** Where the `\bibitem` starts. */
  at: number;
};

/**
 * Every `\bibitem` inside a `thebibliography` environment, in order. Comments are skipped, and
 * so is anything outside the environment: a `\bibitem` there is not a bibliography entry.
 */
export function bibItems(src: string): BibItem[] {
  // Comments out of the way, keeping every offset: a comment runs to the end of its line.
  const clean = src.replace(
    /(^|[^\\])((?:\\\\)*)%[^\n]*/g,
    (m, a: string, b: string) => a + b + ' '.repeat(m.length - a.length - b.length),
  );
  const out: BibItem[] = [];
  const ENV = /\\begin\{thebibliography\}/g;
  for (let env = ENV.exec(clean); env; env = ENV.exec(clean)) {
    const close = clean.indexOf('\\end{thebibliography}', env.index);
    const stop = close < 0 ? clean.length : close;
    const body = clean.slice(0, stop);
    const ITEM = /\\bibitem\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g;
    ITEM.lastIndex = env.index;
    const found: { key: string; at: number; end: number }[] = [];
    for (let m = ITEM.exec(body); m; m = ITEM.exec(body))
      if (m[1].trim()) found.push({ key: m[1].trim(), at: m.index, end: m.index + m[0].length });
    found.forEach((item, n) =>
      out.push({
        key: item.key,
        text: clean
          .slice(item.end, found[n + 1]?.at ?? stop)
          .replace(/\s+/g, ' ')
          .trim(),
        at: item.at,
      }),
    );
    ENV.lastIndex = stop;
  }
  return out;
}

/**
 * The entries of a .bbl, the file BibTeX or biblatex wrote, with the first of each key only. A
 * BibTeX .bbl is a `thebibliography` and is read as one. A biblatex .bbl has `\entry{key}{type}{}`
 * up to `\endentry`, its text being the first `\field{title}{...}`; biblatex repeats an entry
 * for each datalist and refsection. Neither: no entries.
 */
export function bblEntries(text: string): BibItem[] {
  const out: BibItem[] = [...bibItems(text)];
  const ENTRY = /\\entry\{([^{}]+)\}\{[^{}]*\}/g;
  for (let m = ENTRY.exec(text); m; m = ENTRY.exec(text)) {
    const from = m.index + m[0].length;
    const stop = text.indexOf('\\endentry', from);
    const body = text.slice(from, stop < 0 ? text.length : stop);
    const title = /\\field\{title\}\s*\{/.exec(body);
    const open = title ? title.index + title[0].length - 1 : -1;
    out.push({
      key: m[1].trim(),
      text: title
        ? body
            .slice(open + 1, closeOf(body, open) - 1)
            .replace(/\s+/g, ' ')
            .trim()
        : '',
      at: m.index,
    });
  }
  const seen = new Set<string>();
  return out.filter((e) => !seen.has(e.key) && seen.add(e.key)).sort((a, b) => a.at - b.at);
}

/**
 * The DOI an entry gives, as the bare `10.xxxx/...` a registry is asked for: TeX escapes and
 * braces taken away, a `doi:`, `DOI ` or doi.org address taken off the front, and trailing
 * punctuation off the end. With no `doi` field, a `url` on doi.org is used. Empty if none.
 */
export function cleanDoi(entry: { fields: Record<string, string> }) {
  const { doi, url } = entry.fields;
  const bare = (raw: string) =>
    raw
      .replace(/\\url(?![a-zA-Z])/g, '')
      .replace(/\\([&%$#_{}])/g, '$1')
      .replace(/[{}]/g, '')
      .trim()
      .replace(/^(?:doi\s*:?\s*)?(?:https?:\/\/(?:www\.)?(?:dx\.)?doi\.org\/)?/i, '')
      .replace(/[.,;]+$/, '')
      .trim();
  const own = doi ? bare(doi) : '';
  if (own) return own;
  return url && /^\s*(?:\\url)?\{?\s*https?:\/\/(?:www\.)?(?:dx\.)?doi\.org\//i.test(url)
    ? bare(url)
    : '';
}
