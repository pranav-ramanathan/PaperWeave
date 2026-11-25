// The simple macros a paper defines, in the form the in-browser maths renderer takes them, so
// that a formula written with the paper's own shorthand is shown as a formula. And the ones that
// only print words (`\newcommand{\sys}{PaperWeave}`), so that text written with them reads as
// those words, in the editor and for the grammar checker.
import { importBase, includes, resolveInclude, rootDir, uncomment } from './graph.ts';
import { LIGATURES } from './bib.ts';
import { finder, groupEnds } from './scan.ts';

export type Definition = {
  /** The name, with its backslash. */
  name: string;
  /** What it is defined as, `#1` and all. */
  body: string;
  /** How many arguments it takes; -1 when it has an optional one or a delimited one. */
  params: number;
  kind: 'new' | 'provide' | 'def' | 'operator';
  /** Where its command starts. */
  at: number;
};

/** The definitions in `src` in the order they are written, with those the renderer cannot take. */
function definitions(src: string): Definition[] {
  // Comments are blanked, so a definition that is commented out is not one.
  const text = src.replace(
    /(^|[^\\])%.*$/gm,
    (all, before: string) => before + ' '.repeat(all.length - before.length),
  );
  const out: Definition[] = [];
  // A group or option that never closes is paid for once, however many definitions open one (see
  // `groupEnds` and `finder` in scan.ts for why each answer is the one the plain scan gives).
  const find = finder(text);
  const groupEnd = groupEnds(text, { escapes: true });
  const group = (t: string, at: number) => {
    if (t[at] !== '{') return null;
    const end = groupEnd(at);
    return end < 0 ? null : { body: t.slice(at + 1, end - 1), end };
  };
  const COMMAND = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)(\*?)\s*/g;
  for (const m of text.matchAll(COMMAND)) {
    let at = m.index + m[0].length;
    // The name: \name, or {\name}.
    const braced = text[at] === '{';
    const name = /^\\[a-zA-Z@]+/.exec(text.slice(at + (braced ? 1 : 0)))?.[0];
    if (!name) continue;
    at += name.length + (braced ? 2 : 0);
    if (m[1] === 'def') {
      // Only the plain kind: \def\name{...}, with nothing between the name and the body.
      const body = group(text, at);
      if (body) out.push({ name, body: body.body, params: 0, kind: 'def', at: m.index });
      else if (text[at] === '#') out.push({ name, body: '', params: -1, kind: 'def', at: m.index });
      continue;
    }
    const skip = () => {
      while (text[at] === ' ' || text[at] === '\n') at++;
    };
    skip();
    if (m[1] === 'DeclareMathOperator') {
      const body = group(text, at);
      if (body)
        out.push({
          name,
          body: `\\operatorname${m[2]}{${body.body}}`,
          params: 0,
          kind: 'operator',
          at: m.index,
        });
      continue;
    }
    const kind = m[1] === 'providecommand' ? 'provide' : 'new';
    // [n] says how many arguments; a second [..] gives the first a default.
    let params = 0;
    if (text[at] === '[') {
      const close = find(']', at);
      params = close < 0 ? NaN : Number(text.slice(at + 1, close));
      at = close + 1 || text.length;
    }
    skip();
    if (text[at] === '[' || Number.isNaN(params)) {
      out.push({ name, body: '', params: -1, kind, at: m.index });
      continue;
    }
    const body = group(text, at);
    if (body) out.push({ name, body: body.body, params, kind, at: m.index });
  }
  return out;
}

/**
 * Macros defined with `\newcommand` and its relatives, `\def` without parameters, and
 * `\DeclareMathOperator`: name (with its backslash) to replacement text, `#1` and all. A macro
 * with an optional argument is left out: the renderer has no such thing.
 */
export function macroDefs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of definitions(src)) if (d.params >= 0) out[d.name] = d.body;
  return out;
}

const WORD_CHARS = new Set('\\{}$&#^_%');
const MAX_WORD = 80;
const MAX_NESTING = 8;

/**
 * What a macro body prints, when all it does is print words: letters, digits, punctuation, the
 * spaces and dashes TeX makes (`\ `, `~`, `\,`, `--`), the special characters (`\%`), the text
 * commands of `LIGATURES` (`\dots`), `\xspace`, and other macros of the paper that do the same.
 * `defs` maps a name to its body, or to null for a name that is defined but is not a word.
 * Null for anything else, for an empty result, and for one over 80 characters. The words keep
 * the spaces they end or start with: where they are printed decides whether those are said.
 */
export function textOf(
  body: string,
  defs: Record<string, string | null>,
  depth = 0,
): string | null {
  if (depth > MAX_NESTING) return null;
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c === '~') {
      out += ' ';
      i++;
    } else if (c === '-') {
      const dashes = /^-{1,3}/.exec(body.slice(i))![0].length;
      out += dashes === 1 ? '-' : dashes === 2 ? '–' : '—';
      i += dashes;
    } else if (c === '{') {
      if (body[i + 1] !== '}') return null;
      i += 2;
    } else if (c === '\\') {
      const next = body[i + 1];
      const word = /^\\([a-zA-Z@]+)/.exec(body.slice(i));
      if (!word || word[1] === '@') {
        // A control symbol: only these.
        if (next === ' ' || next === '\n') out += ' ';
        else if (next === ',') out += ' ';
        else if (next === '@') out += '';
        else if (next !== undefined && '%&_#$'.includes(next)) out += next;
        else return null;
        i += 2;
        continue;
      }
      const name = word[1]!;
      i += word[0].length;
      let said: string | null;
      let spaced = false;
      if (`\\${name}` in defs) {
        const def = defs[`\\${name}`];
        said = def == null ? null : textOf(def, defs, depth + 1);
        // A macro that ends in \xspace puts the space after it back, so the one written stays.
        spaced = def != null && /\\xspace\s*$/.test(def);
      } else if (name === 'xspace') {
        said = '';
        spaced = true;
      } else said = Object.hasOwn(LIGATURES, name) ? LIGATURES[name]! : null;
      if (said === null) return null;
      out += said;
      // `\name{}` ends the name; otherwise TeX reads the spaces after a name and prints none.
      if (body.startsWith('{}', i)) i += 2;
      else if (!spaced) while (body[i] === ' ' || body[i] === '\t' || body[i] === '\n') i++;
    } else if (WORD_CHARS.has(c)) return null;
    else {
      out += c;
      i++;
    }
  }
  if (depth > 0) return out;
  const said = out.replace(/[ \t\r\n]+/g, ' ').normalize('NFC');
  return /\S/.test(said) && said.length <= MAX_WORD ? said : null;
}

/** The names `LIGATURES` and `\xspace` give a meaning to, which a paper's macro must not take over. */
const OWN = (name: string) => Object.hasOwn(LIGATURES, name.slice(1));
const MAX_NAMES = 256;

/**
 * What is in force at the end of the root's preamble, in the order TeX reads it: the root's head
 * up to `\begin{document}`, descending at each `\input` and at each `\usepackage` or
 * `\documentclass` of the project's own `.sty`/`.cls`; the last definition of a name wins and
 * `\providecommand` does not override. `later` is the text read after that: the body of the root
 * and every file the preamble did not read. Null when there is no such root.
 */
function inForce(
  texts: Record<string, string>,
  root: string,
): { now: Map<string, Definition>; later: string[] } | null {
  const rootText = texts[root];
  if (rootText === undefined) return null;
  const dir = rootDir(root);
  const all = new Set(Object.keys(texts));
  const begins = uncomment(rootText).indexOf('\\begin{document}');
  const head = begins < 0 ? rootText : rootText.slice(0, begins);
  /** What is in force: null for a name defined in a way that is not a word. */
  const now = new Map<string, Definition>();
  const seen = new Set<string>([root]);
  const read = (text: string, base: string, depth: number) => {
    const events: { at: number; run: () => void }[] = [];
    for (const d of definitions(text))
      events.push({
        at: d.at,
        run: () => {
          if (d.kind === 'provide' && now.has(d.name)) return;
          now.set(d.name, d);
        },
      });
    for (const inc of includes(text)) {
      if (inc.dynamic || (inc.kind !== 'input' && inc.kind !== 'support')) continue;
      events.push({
        at: inc.at,
        run: () => {
          const to =
            (base ? resolveInclude(inc, dir + base, all) : undefined) ??
            resolveInclude(inc, dir, all);
          if (!to || seen.has(to) || depth >= MAX_NESTING) return;
          if (inc.kind === 'support' && !/\.(sty|cls)$/i.test(to)) return;
          seen.add(to);
          read(texts[to] ?? '', importBase(inc, base), depth + 1);
        },
      });
    }
    events.sort((a, b) => a.at - b.at).forEach((e) => e.run());
  };
  read(head, '', 0);
  // Anything read after the preamble: the body of the root, and every file the preamble did not
  // read. It may define a name again, and then what the text says is not what the preamble says.
  const later = [begins < 0 ? '' : rootText.slice(begins)];
  for (const path of all) if (!seen.has(path)) later.push(texts[path] ?? '');
  return { now, later };
}

/**
 * The macros of the paper that only print words, by name with the backslash: what each prints.
 * `texts` maps every path of the project's `.tex`, `.ltx`, `.sty` and `.cls` files to its text.
 * They are read in the order TeX reads them: the root's preamble, descending at each `\input`
 * and at each `\usepackage` of the project's own package, so that the last definition wins. A
 * name that the body of the paper (or a file it does not read in the preamble) defines in any
 * other way is left out, as are macros that take arguments.
 */
export function textMacros(texts: Record<string, string>, root: string): Record<string, string> {
  const walked = inForce(texts, root);
  if (!walked) return {};
  const { now, later } = walked;
  const changed = new Set<string>();
  for (const text of later)
    for (const d of definitions(text)) {
      const was = now.get(d.name);
      if (was && (d.params !== 0 || d.kind === 'operator' || d.body !== was.body))
        changed.add(d.name);
    }
  // Names that are not words block the macros that use them.
  const lookup: Record<string, string | null> = {};
  for (const [name, d] of now)
    lookup[name] = d.params === 0 && d.kind !== 'operator' && !changed.has(name) ? d.body : null;
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(lookup)) {
    if (body === null || OWN(name)) continue;
    const said = textOf(body, lookup);
    if (said !== null) out[name] = said;
    if (Object.keys(out).length >= MAX_NAMES) break;
  }
  return out;
}

/** What a macro of the paper prints, written exactly as `\sys` or `\sys{}`; null for anything else. */
export function textMacroOf(src: string, macros: Record<string, string>): string | null {
  const m = /^(\\[a-zA-Z@]+)(?:\{\})?$/.exec(src);
  return (m && macros[m[1]!]) || null;
}

/** The highest `#n` a macro body uses, 0 when it uses none. */
const usedArguments = (body: string) =>
  Math.max(0, ...[...body.matchAll(/#([1-9])/g)].map((m) => Number(m[1])));

/**
 * The macros of the paper in the form the in-browser maths renderer takes: name (with its
 * backslash) to replacement text. Read in TeX's order, from the root's preamble, the files it
 * reads and the project's own packages it loads (`inForce`), so that the last definition of a name
 * wins. The renderer counts a macro's arguments from the highest `#n` its body uses, so a macro
 * that declares more than it uses is wrapped to take (and drop) them. Left out: a macro with an
 * optional or delimited argument (so is a name an optional-argument redefinition has replaced),
 * and a name with `@`, which can not be typed in a document.
 */
export function mathMacros(texts: Record<string, string>, root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, d] of inForce(texts, root)?.now ?? []) {
    if (d.params < 0 || name.includes('@') || d.params > 9) continue;
    out[name] =
      d.params <= usedArguments(d.body) ? d.body : `\\@secondoftwo{#${d.params}}{${d.body}}`;
  }
  return out;
}
