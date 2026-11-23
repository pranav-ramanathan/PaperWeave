// Which files a project pulls in, found without running TeX.

export type Include = {
  /**
   * `support` is a file the build reads that is not text of the paper: a style, a listing, a
   * data file. It is followed by renames only, never walked into, and never reported missing.
   * `only` is an `\includeonly` entry: also followed by renames only, never walked, never an
   * edge, never reported missing.
   */
  kind: 'input' | 'bib' | 'graphics' | 'support' | 'only';
  target: string;
  dynamic: boolean;
  /** Where the command starts in the source. */
  at: number;
  /** Where the target itself starts in the source: the text between the braces, trimmed. */
  targetAt: number;
  /** For `support`: the extension TeX adds to a name written without one (`.sty`). */
  ext?: string;
  /**
   * For `\import{dir}{file}` and its relatives, where the path is written in two groups: `target`
   * is the two joined, `targetAt` is where the file group's text starts, and this is the rest.
   * `sub` is true for the `sub*` forms, whose folder is added to the one in force.
   */
  import?: { dir: string; dirAt: number; file: string; sub: boolean };
};

const CMD =
  /\\(input|includeonly|include|subfile|bibliography|addbibresource|includegraphics)\*?(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
// The `import` package: `\import{dir}{file}`, `\subimport{dir}{file}`, `\includefrom{dir}{file}`.
const IMPORT =
  /\\(import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)\*?\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
// `\input name`: TeX reads the name up to the next space.
const BARE = /\\input\s+([^\s{}%\\#]+)/g;
// Files of the paper that packages and classes read. Each has the extension TeX adds.
const SUPPORT_CMD =
  /\\(usepackage|RequirePackage|documentclass|LoadClass|bibliographystyle|lstinputlisting|verbatiminput|includepdf|pgfplotstableread|csvreader|csvautotabular|includesvg)\*?(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
// `\inputminted[opts]{language}{file}`: the file is the second argument.
const MINTED = /\\inputminted\*?(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{([^{}]*)\}/g;
// pgfplots: `\addplot[opts] table[opts] {file}`.
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
// The extensions pdfTeX tries for a picture named without one, in its order, then EPS.
const GRAPHICS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.PDF', '.PNG', '.JPG', '.JPEG', '.eps'];

// Comments and verbatim text are blanked, not removed, so that every offset is still an offset
// into the source. A % is a comment unless an odd number of backslashes come before it.
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
  /** `list` is the text between the braces; `at` is where it starts. */
  const add = (command: string, at: number, list: string, partAt: number, split: boolean) => {
    const kind = KIND[command] ?? 'input';
    for (const t of split ? list.split(',') : [list]) {
      let target = t.trim();
      let targetAt = partAt + t.indexOf(target);
      partAt += t.length + 1;
      // A name in double quotes: the quotes are not part of it.
      if (target.length > 2 && target.startsWith('"') && target.endsWith('"')) {
        target = target.slice(1, -1);
        targetAt += 1;
      }
      // A macro or parameter in the path can only be resolved by TeX: such files are source-only.
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
  // The target is the last group, and has no braces inside it.
  const braced = (m: RegExpExecArray, command: string) =>
    add(command, m.index, m[m.length - 1], m.index + m[0].lastIndexOf('{') + 1, LISTS.has(command));
  for (const m of live.matchAll(CMD)) braced(m, m[1]);
  for (const m of live.matchAll(SUPPORT_CMD)) braced(m, m[1]);
  for (const m of live.matchAll(MINTED)) braced(m, 'verbatiminput');
  for (const m of live.matchAll(PLOT)) braced(m, 'verbatiminput');
  for (const m of live.matchAll(IMPORT)) {
    // `target` is the two groups joined, as written. `includeGraph` reads the folder in force
    // from `import.dir`; `nameSplices` reads `target`.
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
  // The graph walks \input in the order they are written.
  return out.sort((a, b) => a.at - b.at || a.targetAt - b.targetAt);
}

const REACH_DEPTH = 8;
const REACH_FILES = 50;
const REACH_BYTES = 1_000_000;

/**
 * Whether `path` is a root: it has \\begin{document}, and a \\documentclass comes before it,
 * either in the file or in a file its preamble `\\input`s or `\\include`s (read whole, and itself
 * following further `\\input`s). The walk is bounded: each file once, 8 deep, 50 files, 1 MB.
 * `all` is every path in the project.
 */
export function reachesClass(
  files: Record<string, string>,
  path: string,
  all: ReadonlySet<string> = new Set(Object.keys(files)),
): boolean {
  const text = files[path];
  if (text === undefined) return false;
  const live = uncomment(text);
  const body = live.indexOf('\\begin{document}');
  if (body < 0) return false;
  const head = live.slice(0, body);
  if (head.includes('\\documentclass')) return true;
  const dir = rootDir(path);
  const seen = new Set<string>([path]);
  let scanned = 0;
  const walk = (src: string, base: string, depth: number): boolean => {
    for (const inc of includes(src)) {
      if (inc.dynamic || inc.kind !== 'input') continue;
      const to =
        (base ? resolveInclude(inc, dir + base, all) : undefined) ?? resolveInclude(inc, dir, all);
      if (!to || seen.has(to) || seen.size > REACH_FILES) continue;
      const t = files[to];
      if (t === undefined) continue;
      seen.add(to);
      scanned += t.length;
      if (scanned > REACH_BYTES) return false;
      if (uncomment(t).includes('\\documentclass')) return true;
      if (depth < REACH_DEPTH && walk(t, importBase(inc, base), depth + 1)) return true;
    }
    return false;
  };
  return walk(head, '', 1);
}

/** The file that has \\begin{document} with a \\documentclass before it, in it or in a file it reads. */
export function findRoot(files: Record<string, string>): string | null {
  const all = new Set(Object.keys(files));
  const keys = Object.keys(files);
  const direct = keys.filter(
    (p) => files[p].includes('\\documentclass') && files[p].includes('\\begin{document}'),
  );
  const roots = direct.length ? direct : keys.filter((p) => reachesClass(files, p, all));
  return (
    roots.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0] ?? null
  );
}

export const norm = (path: string) => {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
};

/** The directory TeX resolves paths against: the root file's, with its trailing slash, or ''. */
export const rootDir = (root: string) =>
  root.includes('/') ? root.slice(0, root.lastIndexOf('/') + 1) : '';

const GRAPHICSPATH = /\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g;

const folders = (list: string) =>
  [...list.matchAll(/\{([^{}]*)\}/g)].map((g) => g[1].trim()).filter(Boolean);

/**
 * The folders `\\graphicspath{{a/}{b/}}` names, as written: `['a/', 'b/']`. In one text a later
 * `\\graphicspath` replaces an earlier one, as in TeX. For a whole paper use `projectGraphicsPaths`.
 */
export function graphicsPaths(text: string): string[] {
  const all = [...uncomment(text).matchAll(GRAPHICSPATH)];
  return all.length ? folders(all[all.length - 1][1]) : [];
}

/**
 * The `\\graphicspath` folders in force for the paper's pictures: set in the root's preamble, in
 * the files it `\\input`s or `\\include`s there and in the project's own `.sty` and `.cls` it loads,
 * read in TeX's order, the last setting replacing the ones before it. A setting in the body of the
 * root file is added to those, as it always has been. `all` is every path in the project.
 */
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

/**
 * The project file an include names, if there is one, and the `\\graphicspath` folder it was
 * found through (`''` for none): the path as written, or with the extension TeX would add for
 * that kind of include. `all` is every path in the project.
 */
export function resolveVia(
  inc: Include,
  dir: string,
  all: ReadonlySet<string>,
  via: string[] = [],
): { path: string; via: string } | undefined {
  if (inc.dynamic) return undefined;
  for (const v of inc.kind === 'graphics' ? ['', ...via] : ['']) {
    const base = norm(dir + v + inc.target);
    const tries =
      inc.kind === 'graphics'
        ? GRAPHICS.map((x) => base + x)
        : inc.kind === 'support'
          ? [...(inc.ext ? [base + inc.ext] : []), base]
          : [base, base + (inc.kind === 'bib' ? '.bib' : '.tex')];
    const path = tries.find((p) => all.has(p));
    if (path) return { path, via: v };
  }
  return undefined;
}

/** The import folder an `\\import`-family include sets for the file it reads; `base` is the one in force. */
export const importBase = (inc: Include, base: string) => {
  if (inc.kind !== 'input') return base;
  if (!inc.import) return base;
  const folder = norm((inc.import.sub ? base : '') + '/' + inc.import.dir);
  return folder ? folder + '/' : '';
};

export const resolveInclude = (
  inc: Include,
  dir: string,
  all: ReadonlySet<string>,
  via: string[] = [],
) => resolveVia(inc, dir, all, via)?.path;

export type Graph = {
  /** Text files reachable from the root, root first. */
  order: string[];
  /**
   * Files read before \begin{document}. They hold definitions, not prose, and text typed into
   * them would break the build, so they are edited in the source editor only.
   */
  preamble: string[];
  edges: { from: string; to: string; kind: Include['kind'] }[];
  /** `at` is where in `from` the target is named. */
  missing: { from: string; target: string; at: number }[];
  dynamic: { from: string; target: string }[];
  cycles: string[][];
  /** The import folder in force in each visited file, with its trailing slash: `''` at the root. */
  base: Record<string, string>;
};

/**
 * `files` maps every project path to its text; `paths` lists all paths, binary ones included.
 * `via` is the paper's `\\graphicspath` folders when `files` lacks the `.sty` and `.cls` files
 * that may set them: pass `projectGraphicsPaths` of a map that has them.
 */
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
      // \includeonly only filters the \include lines; it reads nothing itself.
      if (inc.kind === 'only') continue;
      if (inc.dynamic) {
        if (inc.kind === 'support') continue;
        g.dynamic.push({ from, target: inc.target });
        continue;
      }
      // TeX looks in the import folder in force first, then in the directory it was started in:
      // the root's. A picture tries the import folder before \graphicspath; a bibliography is
      // read by BibTeX or biber from the root's folder alone.
      const to =
        (inc.kind !== 'bib' && base ? resolveInclude(inc, dir + base, all) : undefined) ??
        resolveInclude(inc, dir, all, via);
      if (!to) {
        // A package or class may be the system's: only a file of the paper is followed.
        if (inc.kind === 'support') continue;
        g.missing.push({ from, target: inc.target, at: inc.targetAt });
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

/**
 * The chapters an \includeonly in the root's preamble leaves out of the PDF: the names \include'd
 * in `order` (the files the paper reads) that the last \includeonly before \begin{document} does
 * not name. Null when there is no such \includeonly, when it names a macro, or when it leaves
 * nothing out. `at` is where that \includeonly starts in the root.
 */
export function leftOut(
  files: Record<string, string>,
  root: string,
  order: string[] = [root],
): { at: number; names: string[] } | null {
  const live = uncomment(files[root] ?? '');
  const body = live.indexOf('\\begin{document}');
  if (body < 0) return null;
  // TeX compares the names as plain strings: no folder or case normalising.
  const name = (t: string) => {
    let n = t.trim();
    if (n.length > 2 && n.startsWith('"') && n.endsWith('"')) n = n.slice(1, -1).trim();
    return n.replace(/\.tex$/, '');
  };
  const only = [...live.slice(0, body).matchAll(/\\includeonly\s*\{([^{}]*)\}/g)].pop();
  if (!only) return null;
  const named = only[1].split(',').map(name).filter(Boolean);
  if (named.some((n) => /[\\#]/.test(n))) return null;
  const out = new Set<string>();
  for (const path of order)
    for (const m of uncomment(files[path] ?? '').matchAll(/\\include\s*\{([^{}]*)\}/g)) {
      const target = name(m[1]);
      if (target && !/[\\#]/.test(target) && !named.includes(target)) out.add(target);
    }
  return out.size ? { at: only.index, names: [...out] } : null;
}

/**
 * The ready-made `.bbl` files among `paths` that the paper needs: one a file the root reaches
 * reads by name, and the root's own `.bbl` (same folder and base name) when a file the root
 * reaches names a `.bib` that is not in the project (from the root's folder), or names one through
 * a macro, so BibTeX or biber cannot make it again. `lacks` lists those `.bib` names.
 */
export function readyMadeBbls(
  files: Record<string, string>,
  root: string,
  paths: string[],
): { path: string; lacks: string[] }[] {
  const g = includeGraph(files, root, paths);
  const out = new Map<string, string[]>();
  for (const e of g.edges) if (/\.bbl$/i.test(e.to)) out.set(e.to, []);
  const own = root.replace(/\.(tex|ltx)$/i, '') + '.bbl';
  if (paths.includes(own)) {
    const all = new Set(paths);
    const dir = rootDir(root);
    const lacks: string[] = [];
    for (const p of g.order)
      for (const inc of includes(files[p] ?? '')) {
        if (inc.kind !== 'bib') continue;
        if (inc.dynamic || !resolveInclude(inc, dir, all)) lacks.push(inc.target);
      }
    if (lacks.length) out.set(own, [...new Set([...(out.get(own) ?? []), ...lacks])]);
  }
  return [...out].map(([path, lacks]) => ({ path, lacks }));
}
