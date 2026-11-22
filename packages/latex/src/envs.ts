// The theorem-like environments a paper declares for itself (\newtheorem{observation}{...}),
// so that their bodies can be edited as prose like those of `lemma` and `theorem`.
import { includes, includeGraph, resolveInclude, rootDir, uncomment } from './graph.ts';
import { MATH_ENV, VERBATIM } from './parse.ts';

/** The most names one paper may add. */
export const MAX_PROSE_ENVS = 64;

/**
 * Environments that are never prose, whatever a paper's preamble says: maths and verbatim ones
 * (the parser's own sets), lists, floats, tables, and the document itself.
 */
export const RESERVED: ReadonlySet<string> = new Set([
  ...MATH_ENV,
  ...VERBATIM,
  ...['document', 'itemize', 'enumerate', 'description', 'figure', 'table', 'tabular', 'tabularx'],
  ...['array', 'thebibliography', 'tikzpicture', 'subfigure', 'minipage', 'algorithm', 'split'],
  ...['cases', 'matrix', 'pmatrix', 'bmatrix', 'verse', 'picture', 'longtable', 'wrapfigure'],
]);

/** A name safe to add to the set: plain letters, at most 32, and not a reserved environment. */
export function validEnv(name: unknown): name is string {
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

/**
 * The environment names the paper declares as theorems: in the root file before
 * `\begin{document}`, in the files that preamble reads, and in the project's own `.sty` and
 * `.cls` files that the preamble loads. `texts` maps every project path to its text.
 * Sorted, without repeats, at most MAX_PROSE_ENVS.
 */
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
  // Packages and classes of the paper itself, and those they load in turn.
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
