// Which files a project pulls in, found without running TeX.

export type Include = {
  /**
   * `support` is a file the build reads that is not text of the paper: a style, a listing, a
   * data file. It is followed by renames only, never walked into, and never reported missing.
   */
  kind: 'input' | 'bib' | 'graphics' | 'support';
  target: string;
  dynamic: boolean;
  /** Where the command starts in the source. */
  at: number;
  /** Where the target itself starts in the source: the text between the braces, trimmed. */
  targetAt: number;
  /** For `support`: the extension TeX adds to a name written without one (`.sty`). */
  ext?: string;
};

const CMD =
  /\\(input|include|subfile|bibliography|addbibresource|includegraphics)\*?(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
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
const LISTS = new Set(['bibliography', 'usepackage', 'RequirePackage']);
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
const uncomment = (src: string) =>
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
  for (const m of live.matchAll(BARE))
    add('input', m.index, m[1], m.index + m[0].length - m[1].length, false);
  // The graph walks \input in the order they are written.
  return out.sort((a, b) => a.at - b.at || a.targetAt - b.targetAt);
}

/** The file that holds both \documentclass and \begin{document}. */
export function findRoot(files: Record<string, string>): string | null {
  const roots = Object.keys(files).filter(
    (p) => files[p].includes('\\documentclass') && files[p].includes('\\begin{document}'),
  );
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

/** The folders `\\graphicspath{{a/}{b/}}` names, as written: `['a/', 'b/']`. Pass the root file's text. */
export function graphicsPaths(rootText: string): string[] {
  const out: string[] = [];
  for (const m of uncomment(rootText).matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g))
    for (const g of m[1].matchAll(/\{([^{}]*)\}/g)) {
      const folder = g[1].trim();
      if (folder) out.push(folder);
    }
  return out;
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
};

/** `files` maps every project path to its text; `paths` lists all paths, binary ones included. */
export function includeGraph(
  files: Record<string, string>,
  root: string,
  paths: string[] = Object.keys(files),
): Graph {
  const all = new Set(paths);
  const dir = rootDir(root);
  const via = graphicsPaths(files[root] ?? '');
  const g: Graph = { order: [], preamble: [], edges: [], missing: [], dynamic: [], cycles: [] };
  const body = uncomment(files[root] ?? '').indexOf('\\begin{document}');
  const stack: string[] = [];
  const visit = (from: string, preamble = false) => {
    if (stack.includes(from)) {
      g.cycles.push([...stack.slice(stack.indexOf(from)), from]);
      return;
    }
    if (g.order.includes(from)) return;
    g.order.push(from);
    if (preamble) g.preamble.push(from);
    stack.push(from);
    for (const inc of includes(files[from] ?? '')) {
      if (inc.dynamic) {
        if (inc.kind === 'support') continue;
        g.dynamic.push({ from, target: inc.target });
        continue;
      }
      // TeX resolves every path against the directory it was started in: the root's.
      const to = resolveInclude(inc, dir, all, via);
      if (!to) {
        // A package or class may be the system's: only a file of the paper is followed.
        if (inc.kind === 'support') continue;
        g.missing.push({ from, target: inc.target, at: inc.targetAt });
        continue;
      }
      g.edges.push({ from, to, kind: inc.kind });
      if (inc.kind === 'input') visit(to, preamble || (from === root && inc.at < body));
    }
    stack.pop();
  };
  visit(root);
  return g;
}
