// Which files a project pulls in, found without running TeX.

export type Include = {
  kind: 'input' | 'bib' | 'graphics';
  target: string;
  dynamic: boolean;
  /** Where the command starts in the source. */
  at: number;
  /** Where the target itself starts in the source: the text between the braces, trimmed. */
  targetAt: number;
};

const CMD =
  /\\(input|include|subfile|bibliography|addbibresource|includegraphics)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g;
const KIND: Record<string, Include['kind']> = {
  bibliography: 'bib',
  addbibresource: 'bib',
  includegraphics: 'graphics',
};
// The extensions pdfTeX tries for a picture named without one, in its order, then EPS.
const GRAPHICS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.PDF', '.PNG', '.JPG', '.JPEG', '.eps'];

// Comments are blanked, not removed, so that every offset is still an offset into the source.
const uncomment = (src: string) =>
  src.replace(
    /(^|[^\\])%.*$/gm,
    (all, before: string) => before + ' '.repeat(all.length - before.length),
  );

export function includes(src: string): Include[] {
  const live = uncomment(src);
  const out: Include[] = [];
  for (const m of live.matchAll(CMD)) {
    const kind = KIND[m[1]] ?? 'input';
    // The target is the last group, and has no braces inside it.
    let partAt = m.index + m[0].lastIndexOf('{') + 1;
    // \bibliography takes a comma-separated list.
    for (const t of m[1] === 'bibliography' ? m[2].split(',') : [m[2]]) {
      const target = t.trim();
      const targetAt = partAt + t.indexOf(target);
      partAt += t.length + 1;
      // A macro or parameter in the path can only be resolved by TeX: such files are source-only.
      if (target) out.push({ kind, target, dynamic: /[\\#]/.test(target), at: m.index, targetAt });
    }
  }
  return out;
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

const norm = (path: string) => {
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

/**
 * The project file an include names, if there is one: the path as written, or with the
 * extension TeX would add for that kind of include. `all` is every path in the project.
 */
export function resolveInclude(inc: Include, dir: string, all: ReadonlySet<string>) {
  if (inc.dynamic) return undefined;
  const base = norm(dir + inc.target);
  const tries =
    inc.kind === 'graphics'
      ? GRAPHICS.map((x) => base + x)
      : [base, base + (inc.kind === 'bib' ? '.bib' : '.tex')];
  return tries.find((p) => all.has(p));
}

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
        g.dynamic.push({ from, target: inc.target });
        continue;
      }
      // TeX resolves every path against the directory it was started in: the root's.
      const to = resolveInclude(inc, dir, all);
      if (!to) {
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
