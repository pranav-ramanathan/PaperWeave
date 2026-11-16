// Which files a project pulls in, found without running TeX.

export type Include = { kind: 'input' | 'bib' | 'graphics'; target: string; dynamic: boolean };

const CMD =
  /\\(input|include|subfile|bibliography|addbibresource|includegraphics)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g;
const KIND: Record<string, Include['kind']> = {
  bibliography: 'bib',
  addbibresource: 'bib',
  includegraphics: 'graphics',
};
const GRAPHICS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps'];

export function includes(src: string): Include[] {
  const live = src.replace(/(^|[^\\])%.*$/gm, '$1');
  const out: Include[] = [];
  for (const m of live.matchAll(CMD)) {
    const kind = KIND[m[1]] ?? 'input';
    // \bibliography takes a comma-separated list.
    for (const t of m[1] === 'bibliography' ? m[2].split(',') : [m[2]]) {
      const target = t.trim();
      // A macro or parameter in the path can only be resolved by TeX: such files are source-only.
      if (target) out.push({ kind, target, dynamic: /[\\#]/.test(target) });
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

export type Graph = {
  /** Text files reachable from the root, root first. */
  order: string[];
  edges: { from: string; to: string; kind: Include['kind'] }[];
  missing: { from: string; target: string }[];
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
  const dir = root.includes('/') ? root.slice(0, root.lastIndexOf('/') + 1) : '';
  const g: Graph = { order: [], edges: [], missing: [], dynamic: [], cycles: [] };
  const stack: string[] = [];
  const visit = (from: string) => {
    if (stack.includes(from)) {
      g.cycles.push([...stack.slice(stack.indexOf(from)), from]);
      return;
    }
    if (g.order.includes(from)) return;
    g.order.push(from);
    stack.push(from);
    for (const inc of includes(files[from] ?? '')) {
      if (inc.dynamic) {
        g.dynamic.push({ from, target: inc.target });
        continue;
      }
      // TeX resolves every path against the directory it was started in: the root's.
      const base = norm(dir + inc.target);
      const tries =
        inc.kind === 'graphics'
          ? GRAPHICS.map((x) => base + x)
          : [base, base + (inc.kind === 'bib' ? '.bib' : '.tex')];
      const to = tries.find((p) => all.has(p));
      if (!to) {
        g.missing.push({ from, target: inc.target });
        continue;
      }
      g.edges.push({ from, to, kind: inc.kind });
      if (inc.kind === 'input') visit(to);
    }
    stack.pop();
  };
  visit(root);
  return g;
}
