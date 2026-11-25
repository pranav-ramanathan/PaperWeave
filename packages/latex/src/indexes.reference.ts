// Test-only. The index functions of this package as they were before their look-aheads were
// memoized (labels.ts, graph.ts, envs.ts, macros.ts, bib.ts, spelling.ts, floats.ts), copied
// unchanged (a few helpers renamed where two files had the same name) so that
// `indexes.differential.test.ts` can check every answer of the new ones against them. They scan to
// the end of the text for each opener that never closes, and are quadratic on such text.
//
// The one difference: the old multicite loop never ended on `\cites{` with no closing brace (it
// made no progress and asked again, for ever). It is cut off here by the same two lines as in
// labels.ts, so that this copy can be run on any text; every text it ended on gives the same answer.
import { type Graph, type Include, importBase, norm, resolveInclude, rootDir } from './graph.ts';
import { type BibItem, LIGATURES } from './bib.ts';
import { CITES, MULTICITES, REFS, type LabelDef, type RefUse } from './labels.ts';
import { type Float, type Graphic, type Span, type Table } from './floats.ts';
import { type Definition, textOf } from './macros.ts';
import { type Spelling } from './spelling.ts';
import { MATH_ENV, VERBATIM as VERBATIM_ENVS } from './parse.ts';

// ---- labels.ts ----

const VERBATIM = /^\\begin\{(verbatim\*?|lstlisting|minted|Verbatim|comment)\}/;
const VERBATIM_ARG = new Set(['url', 'nolinkurl', 'path', 'href']);
function verbatimGroup(src: string, at: number): number {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i + 1;
  }
  return 0;
}

type Use = { key: string; command: string; at: number; end: number; keyAt: number };

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

function listingLabel(
  src: string,
  open: number,
): { key?: string; keyAt: number; close: number } | null {
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
    let text = src.slice(a, b);
    text = text.replace(/%[^\n]*/g, (m) => ' '.repeat(m.length));
    const head = /^\s*label\s*=\s*/.exec(text);
    if (!head) continue;
    let valueAt = a + head[0].length;
    let value = text.slice(head[0].length);
    if (value.startsWith('{')) {
      const end = verbatimGroup(src, valueAt);
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

function keyUses(src: string, wanted: (command: string) => boolean): Use[] {
  const out: Use[] = [];
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
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c !== '\\') continue;
    const verbatim = VERBATIM.exec(src.slice(i, i + 24));
    if (verbatim) {
      if (verbatim[1] === 'lstlisting' && wanted('label')) {
        let o = i + verbatim[0].length;
        while (src[o] === ' ' || src[o] === '\t') o++;
        const opts = src[o] === '[' ? listingLabel(src, o) : null;
        if (opts && opts.key !== undefined)
          out.push({
            key: opts.key,
            command: 'label',
            at: i,
            end: opts.close + 1,
            keyAt: opts.keyAt,
          });
      }
      const close = src.indexOf(`\\end{${verbatim[1]}}`, i);
      i = close < 0 ? src.length : close;
      continue;
    }
    const name = /^\\([a-zA-Z]+)\*?/.exec(src.slice(i, i + 24));
    if (!name) {
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
      const end = verbatimGroup(src, p);
      if (end) {
        i = end - 1;
        continue;
      }
    }
    if (name[1] === 'lstinputlisting' && wanted('label')) {
      const o = skipWs(p);
      const opts = src[o] === '[' ? listingLabel(src, o) : null;
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
    const multi = MULTICITES.has(name[1]);
    const cite = CITES.has(name[1]);
    for (let unit = 0; unit === 0 || multi; unit++) {
      const before = p;
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
      if (unit > 0 && src[u] !== '{') break;
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
      // The cut-off described at the top of the file.
      if (unit > 0 && u === before) break;
    }
    i = p - 1;
  }
  return out;
}

export function labelIndex(src: string): { labels: LabelDef[]; refs: RefUse[] } {
  const uses = keyUses(src, (name) => name === 'label' || REFS.has(name));
  return {
    labels: uses
      .filter((u) => u.command === 'label')
      .map(({ key, at, end, keyAt }) => ({ key, at, end, keyAt })),
    refs: uses.filter((u) => u.command !== 'label'),
  };
}

export function citeIndex(src: string): Use[] {
  return keyUses(src, (name) => CITES.has(name)).filter((u) => u.key !== '*');
}

// ---- graph.ts ----

const CMD =
  /\\(input|includeonly|include|subfile|bibliography|addbibresource|includegraphics)\*?(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
const IMPORT =
  /\\(import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)\*?\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
const BARE = /\\input\s+([^\s{}%\\#]+)/g;
const SUPPORT_CMD =
  /\\(usepackage|RequirePackage|documentclass|LoadClass|bibliographystyle|lstinputlisting|verbatiminput|includepdf|pgfplotstableread|csvreader|csvautotabular|includesvg)\*?(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
const MINTED = /\\inputminted\*?(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{([^{}]*)\}/g;
const PLOT = /\\addplot3?[+*]?\s*(?:\[[^\]]*\])?\s*table\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
const KIND: Record<string, Include['kind']> = {
  bibliography: 'bib',
  includeonly: 'only',
  addbibresource: 'bib',
  includegraphics: 'graphics',
  usepackage: 'support',
  RequirePackage: 'support',
  documentclass: 'support',
  LoadClass: 'support',
  bibliographystyle: 'support',
  lstinputlisting: 'support',
  verbatiminput: 'support',
  includepdf: 'support',
  pgfplotstableread: 'support',
  csvreader: 'support',
  csvautotabular: 'support',
  includesvg: 'support',
};
const LISTS = new Set(['bibliography', 'includeonly', 'usepackage', 'RequirePackage']);
const ADDED: Record<string, string> = {
  usepackage: '.sty',
  RequirePackage: '.sty',
  documentclass: '.cls',
  LoadClass: '.cls',
  bibliographystyle: '.bst',
  includesvg: '.svg',
};
const GRAPHICS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.PDF', '.PNG', '.JPG', '.JPEG', '.eps'];

export const uncomment = (src: string) =>
  src
    .replace(
      /((?:^|[^\\])(?:\\\\)*)%.*$/gm,
      (all, before: string) => before + ' '.repeat(all.length - before.length),
    )
    .replace(/\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g, (all) =>
      all.replace(/[^\n]/g, ' '),
    );

export function includes(src: string): Include[] {
  const live = uncomment(src);
  const out: Include[] = [];
  const add = (command: string, at: number, list: string, partAt: number, split: boolean) => {
    const kind = KIND[command] ?? 'input';
    for (const t of split ? list.split(',') : [list]) {
      let target = t.trim();
      let targetAt = partAt + t.indexOf(target);
      partAt += t.length + 1;
      if (target.length > 2 && target.startsWith('"') && target.endsWith('"')) {
        target = target.slice(1, -1);
        targetAt += 1;
      }
      if (target)
        out.push({
          kind,
          target,
          dynamic: /[\\#]/.test(target),
          at,
          targetAt,
          ...(ADDED[command] ? { ext: ADDED[command] } : {}),
        });
    }
  };
  const braced = (m: RegExpExecArray, command: string) =>
    add(command, m.index, m[m.length - 1], m.index + m[0].lastIndexOf('{') + 1, LISTS.has(command));
  for (const m of live.matchAll(CMD)) braced(m, m[1]);
  for (const m of live.matchAll(SUPPORT_CMD)) braced(m, m[1]);
  for (const m of live.matchAll(MINTED)) braced(m, 'verbatiminput');
  for (const m of live.matchAll(PLOT)) braced(m, 'verbatiminput');
  for (const m of live.matchAll(IMPORT)) {
    const [dir, file] = [m[2].trim(), m[3].trim()];
    if (!file) continue;
    const target = dir && !dir.endsWith('/') ? `${dir}/${file}` : dir + file;
    const dirAt = m.index + m[0].indexOf('{') + 1 + m[2].indexOf(dir);
    const targetAt = m.index + m[0].lastIndexOf('{') + 1 + m[3].indexOf(file);
    out.push({
      kind: 'input',
      target,
      dynamic: /[\\#]/.test(target),
      at: m.index,
      targetAt,
      import: { dir, dirAt, file, sub: m[1].startsWith('sub') },
    });
  }
  for (const m of live.matchAll(BARE))
    add('input', m.index, m[1], m.index + m[0].length - m[1].length, false);
  return out.sort((a, b) => a.at - b.at || a.targetAt - b.targetAt);
}

const GRAPHICSPATH = /\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g;
const folders = (list: string) =>
  [...list.matchAll(/\{([^{}]*)\}/g)].map((g) => g[1].trim()).filter(Boolean);

export function graphicsPaths(text: string): string[] {
  const all = [...uncomment(text).matchAll(GRAPHICSPATH)];
  return all.length ? folders(all[all.length - 1][1]) : [];
}

export function projectGraphicsPaths(
  files: Record<string, string>,
  root: string,
  all: ReadonlySet<string> = new Set(Object.keys(files)),
): string[] {
  const rootText = files[root];
  if (rootText === undefined) return [];
  const dir = rootDir(root);
  const begins = uncomment(rootText).indexOf('\\begin{document}');
  const head = begins < 0 ? rootText : rootText.slice(0, begins);
  let current: string[] = [];
  const seen = new Set<string>([root]);
  const read = (text: string, base: string) => {
    const events: { at: number; run: () => void }[] = [];
    for (const m of uncomment(text).matchAll(GRAPHICSPATH))
      events.push({ at: m.index, run: () => (current = folders(m[1])) });
    for (const inc of includes(text)) {
      if (inc.dynamic || (inc.kind !== 'input' && inc.kind !== 'support')) continue;
      events.push({
        at: inc.at,
        run: () => {
          const to =
            (base ? resolveInclude(inc, dir + base, all) : undefined) ??
            resolveInclude(inc, dir, all);
          if (!to || seen.has(to)) return;
          if (inc.kind === 'support' && !/\.(sty|cls)$/i.test(to)) return;
          seen.add(to);
          read(files[to] ?? '', importBase(inc, base));
        },
      });
    }
    events.sort((a, b) => a.at - b.at).forEach((e) => e.run());
  };
  read(head, '');
  if (begins >= 0) current = [...current, ...graphicsPaths(rootText.slice(begins))];
  return current;
}

function candidates(inc: Include, dir: string, v: string): string[] {
  const base = norm(dir + v + inc.target);
  return inc.kind === 'graphics'
    ? GRAPHICS.map((x) => base + x)
    : inc.kind === 'support'
      ? [...(inc.ext ? [base + inc.ext] : []), base]
      : [base, base + (inc.kind === 'bib' ? '.bib' : '.tex')];
}

function sameButCase(names: string[], paths: Iterable<string>): string | undefined {
  const all = [...paths];
  if (names.some((n) => all.includes(n))) return undefined;
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return all.filter((p) => lower.has(p.toLowerCase())).sort((a, b) => a.localeCompare(b))[0];
}

export function includeGraph(
  files: Record<string, string>,
  root: string,
  paths: string[] = Object.keys(files),
  via: string[] = projectGraphicsPaths(files, root, new Set(paths)),
): Graph {
  const all = new Set(paths);
  const dir = rootDir(root);
  const g: Graph = {
    order: [],
    preamble: [],
    edges: [],
    missing: [],
    dynamic: [],
    cycles: [],
    base: {},
  };
  const body = uncomment(files[root] ?? '').indexOf('\\begin{document}');
  const stack: string[] = [];
  const visit = (from: string, preamble = false, base = '') => {
    if (stack.includes(from)) {
      g.cycles.push([...stack.slice(stack.indexOf(from)), from]);
      return;
    }
    if (g.order.includes(from)) return;
    g.order.push(from);
    g.base[from] = base;
    if (preamble) g.preamble.push(from);
    stack.push(from);
    for (const inc of includes(files[from] ?? '')) {
      if (inc.kind === 'only') continue;
      if (inc.dynamic) {
        if (inc.kind === 'support') continue;
        g.dynamic.push({ from, target: inc.target });
        continue;
      }
      const to =
        (inc.kind !== 'bib' && base ? resolveInclude(inc, dir + base, all) : undefined) ??
        resolveInclude(inc, dir, all, via);
      if (!to) {
        if (inc.kind === 'support') continue;
        const near = sameButCase(
          [
            ...(inc.kind !== 'bib' && base ? candidates(inc, dir + base, '') : []),
            ...(inc.kind === 'graphics' ? ['', ...via] : ['']).flatMap((v) =>
              candidates(inc, dir, v),
            ),
          ],
          all,
        );
        g.missing.push({ from, target: inc.target, at: inc.targetAt, ...(near ? { near } : {}) });
        continue;
      }
      g.edges.push({ from, to, kind: inc.kind });
      if (inc.kind === 'input')
        visit(to, preamble || (from === root && inc.at < body), importBase(inc, base));
    }
    stack.pop();
  };
  visit(root);
  return g;
}

// ---- envs.ts ----

const MAX_PROSE_ENVS = 64;
const RESERVED: ReadonlySet<string> = new Set([
  ...MATH_ENV,
  ...VERBATIM_ENVS,
  ...['document', 'itemize', 'enumerate', 'description', 'figure', 'table', 'tabular', 'tabularx'],
  ...['array', 'thebibliography', 'tikzpicture', 'subfigure', 'minipage', 'algorithm', 'split'],
  ...['cases', 'matrix', 'pmatrix', 'bmatrix', 'verse', 'picture', 'longtable', 'wrapfigure'],
]);
function validEnv(name: unknown): name is string {
  if (typeof name !== 'string' || !/^[A-Za-z@]{1,32}\*?$/.test(name)) return false;
  return !RESERVED.has(name) && !RESERVED.has(name.replace(/\*$/, ''));
}
const DECLARE = /\\(?:newtheorem|spnewtheorem)\*?\s*\{([^{}]*)\}/g;
const DECLARE_LIST = /\\declaretheorem\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
const MD = /\\newmdtheoremenv\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;

function declared(src: string, into: Set<string>) {
  const live = uncomment(src);
  for (const re of [DECLARE, MD, DECLARE_LIST])
    for (const m of live.matchAll(re))
      for (const n of m[1].split(',')) if (validEnv(n.trim())) into.add(n.trim());
}

export function proseEnvs(texts: Record<string, string>, root: string): string[] {
  const rootText = texts[root];
  if (rootText === undefined) return [];
  const names = new Set<string>();
  const begins = uncomment(rootText).indexOf('\\begin{document}');
  const head = begins < 0 ? rootText : rootText.slice(0, begins);
  declared(head, names);
  const graph = includeGraph(texts, root);
  const preamble = [root, ...graph.preamble];
  for (const path of graph.preamble) declared(texts[path] ?? '', names);
  const all = new Set(Object.keys(texts));
  const seen = new Set<string>();
  const queue = preamble.map((p) => ({ path: p, upto: p === root ? head : (texts[p] ?? '') }));
  for (let next = queue.shift(); next; next = queue.shift()) {
    const dir = rootDir(root);
    for (const inc of includes(next.upto)) {
      if (inc.kind !== 'support') continue;
      const to = resolveInclude(inc, dir, all);
      if (!to || !/\.(sty|cls)$/i.test(to) || seen.has(to)) continue;
      seen.add(to);
      declared(texts[to] ?? '', names);
      queue.push({ path: to, upto: texts[to] ?? '' });
    }
  }
  return [...names].sort().slice(0, MAX_PROSE_ENVS);
}

// ---- macros.ts ----

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

function definitions(src: string): Definition[] {
  const text = src.replace(
    /(^|[^\\])%.*$/gm,
    (all, before: string) => before + ' '.repeat(all.length - before.length),
  );
  const out: Definition[] = [];
  const COMMAND = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)(\*?)\s*/g;
  for (const m of text.matchAll(COMMAND)) {
    let at = m.index + m[0].length;
    const braced = text[at] === '{';
    const name = /^\\[a-zA-Z@]+/.exec(text.slice(at + (braced ? 1 : 0)))?.[0];
    if (!name) continue;
    at += name.length + (braced ? 2 : 0);
    if (m[1] === 'def') {
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
    let params = 0;
    if (text[at] === '[') {
      const close = text.indexOf(']', at);
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

const MAX_NESTING = 8;
const OWN = (name: string) => Object.hasOwn(LIGATURES, name.slice(1));
const MAX_NAMES = 256;

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
  const later = [begins < 0 ? '' : rootText.slice(begins)];
  for (const path of all) if (!seen.has(path)) later.push(texts[path] ?? '');
  return { now, later };
}

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

const usedArguments = (body: string) =>
  Math.max(0, ...[...body.matchAll(/#([1-9])/g)].map((m) => Number(m[1])));

export function mathMacros(texts: Record<string, string>, root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, d] of inForce(texts, root)?.now ?? []) {
    if (d.params < 0 || name.includes('@') || d.params > 9) continue;
    out[name] =
      d.params <= usedArguments(d.body) ? d.body : `\\@secondoftwo{#${d.params}}{${d.body}}`;
  }
  return out;
}

// ---- bib.ts ----

function bibCloseOf(text: string, at: number) {
  const [open, close] = text[at] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === open || text[i] === '{') depth++;
    else if ((text[i] === close || text[i] === '}') && --depth === 0) return i + 1;
  }
  return text.length;
}

export function bibItems(src: string): BibItem[] {
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
            .slice(open + 1, bibCloseOf(body, open) - 1)
            .replace(/\s+/g, ' ')
            .trim()
        : '',
      at: m.index,
    });
  }
  const seen = new Set<string>();
  return out.filter((e) => !seen.has(e.key) && seen.add(e.key)).sort((a, b) => a.at - b.at);
}

// ---- spelling.ts ----

const DECLARED: Record<string, Spelling> = {
  american: 'en-US',
  usenglish: 'en-US',
  usmax: 'en-US',
  us: 'en-US',
  british: 'en-GB',
  ukenglish: 'en-GB',
  uk: 'en-GB',
  australian: 'en-GB',
  newzealand: 'en-GB',
};
const OPTIONS =
  /\\(?:usepackage|RequirePackage|documentclass|PassOptionsToPackage|setdefaultlanguage|setmainlanguage)\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g;

export function declaredSpelling(preamble: string): Spelling | null {
  let found: Spelling | null = null;
  for (const m of preamble.matchAll(OPTIONS)) {
    if (!/^\\(?:documentclass|set)/.test(m[0]) && !/\bbabel\b/.test(m[2])) continue;
    const options = m[1].split(',').map((o) => o.trim().toLowerCase());
    const main = options.find((o) => /^(?:main|variant)\s*=/.test(o));
    const named = (main ? [main.replace(/^.*=\s*/, '')] : options.filter((o) => o.length > 2)).map(
      (o) => DECLARED[o],
    );
    found = named.filter(Boolean).pop() ?? found;
  }
  return found;
}

// ---- floats.ts ----

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
function trimmed(src: string, at: number, end: number, by = src): Span {
  while (at < end && /\s/.test(by[at])) at++;
  while (end > at && /\s/.test(by[end - 1])) end--;
  return span(src, at, end);
}

const RULE = /^\\(hline|toprule|midrule|bottomrule|addlinespace|cline|cmidrule|noalign)\b/;

function tableOf(src: string, text: string): Table | null {
  const begin = /\\begin\{(tabular\*?|tabularx)\}/.exec(text);
  if (!begin) return null;
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
  let rowAt = at;
  const closeCell = (to: number) => {
    let from = cell;
    for (let k = cell; k < to; k++) {
      if (src[k] === '%' && text[k] === ' ') {
        const nl = src.indexOf('\n', k);
        if (nl < 0 || nl >= to) break;
        from = k = nl;
        from++;
      } else if (!/\s/.test(text[k])) break;
    }
    const found = trimmed(src, from, to, text);
    if (!found.text && to - from >= 2) found.at = found.end = to - 1;
    if (found.text !== text.slice(found.at, found.end)) simple = false;
    if (!row.length && from > cell) rowAt = from - 1;
    row.push(found);
  };
  const closeRow = (to: number, terminated: boolean) => {
    if (row.length > 1 || row[0]?.text || terminated) {
      rows.push(row);
      const lead = src.slice(rowAt, row[0].at);
      const indent = lead.includes('\n') ? lead.slice(lead.lastIndexOf('\n') + 1) : '';
      lines.push({ at: rowAt, end: to, terminated, indent: /^\s*$/.test(indent) ? indent : '' });
    }
    row = [];
  };
  for (let i = at; i < end; i++) {
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
      if (text[i] === '*') i++;
      if (text[i] === '[') i = closeOf(text, i, '[', ']');
      if (i < 0) return null;
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

export function argumentsOf(src: string, command: RegExp): Span[] {
  const text = live(src);
  const out: Span[] = [];
  for (const m of text.matchAll(command)) {
    let at = m.index + m[0].length;
    if (out.length && m.index < out[out.length - 1].end) continue;
    while (text[at] === ' ' || text[at] === '\n') at++;
    if (text[at] === '[') at = closeOf(text, at, '[', ']');
    while (text[at] === ' ' || text[at] === '\n') at++;
    const close = at >= 0 && text[at] === '{' ? closeOf(text, at) : -1;
    if (close > 0) out.push(span(src, at + 1, close - 1));
  }
  return out;
}

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
