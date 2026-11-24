// What stands between the paper as it is and a paper that can be sent: everything the service
// already knows is wrong with it, gathered in one place.
import { includeGraph, leftOut } from '@paperweave/latex';
import type pg from 'pg';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { latestBuilds } from './builds.ts';
import { chartPath, listCharts } from './charts.ts';
import { citationReport } from './citations.ts';
import { graphicsFolders, labelReport, texFiles } from './labels.ts';
import { id, openProposalsSql, openThreadsSql } from './projects.ts';
import { unusedInRevision } from './revisions.ts';
import { inScope } from './scope.ts';

export type Finding = {
  /** A problem must be put right before the paper is sent. A warning is worth a look. */
  level: 'problem' | 'warning';
  kind: 'root' | 'file' | 'label' | 'citation' | 'build' | 'compiler' | 'chart' | 'review';
  message: string;
  /** Where to put it right: a place in a file, or a chart. */
  fileId?: string;
  path?: string;
  line?: number;
  chartId?: string;
};
export type Submission = {
  findings: Finding[];
  /** No problem was found: the paper can be sent as built. */
  ready: boolean;
  /** The revision whose ZIP and PDF belong together, once the paper is ready. */
  revisionId: string | null;
  /** A build is waiting or running: look again in a moment. */
  building: boolean;
};

// TeX's per-key warnings: "Citation `x' on page 1 undefined", "Reference `x' ... undefined",
// "Hyper reference `x' ... undefined" (biblatex quotes with '), "Label `x' multiply defined".
// The summary lines ("There were undefined references") name no key and match none of these.
const UNDEFINED = /^(Citation|Reference|Hyper reference) [`'](.+?)' (?:on page \S+ )?undefined/;
const MULTIPLY = /^Label [`'](.+?)' multiply defined/;
/** The worker's warning for an EPS picture the PDF has a box for: the paper is not done. */
const PICTURE = /^Picture not shown: /;
/** The worker's warning for characters the font lacks: the PDF leaves them out. */
const MISSING = /^Characters not shown: /;
const ABBREVIATION = /^Abbreviation not defined: /;
/** The worker's warning for a .bib the paper names and does not have, with no .bbl: the PDF has [?]. */
const NOT_MADE = /^Bibliography not made: /;
/** The worker's error for a .bib biber could not find; on a build that succeeded the .bbl stood in. */
const NO_BIB = /^Biber could not find the bibliography file (.+)\.$/;
const NOT_FOUND = /[`'](.+?)' not found/;
/** Whether a file TeX could not find ("nosuchfile.tex") is the one a command named ("nosuchfile"). */
const namesTarget = (found: string, target: string) => {
  const bare = (p: string) => p.replace(/^\.\//, '').replace(/\.[a-z0-9]+$/i, '');
  return found === target || bare(found) === bare(target);
};

/** Why a missing .bib is only a warning when the build succeeded on a ready-made .bbl. */
export const readyMadeMessage = (bib: string) =>
  `${bib} is not among the paper's files, so the bibliography was not made again: the PDF shows the paper's ready-made .bbl as it stands.`;

/** Why a data file held back from downloads, which the paper reads, is a problem. */
export const heldReadMessage = (path: string) =>
  `The paper reads ${path}, which is not included in downloads: the ZIP would not build without it. Include it in downloads, or draw the chart here and include the drawing instead.`;

/** Why chapters an active \includeonly leaves out of the PDF are a problem, and the way out. */
export const leftOutMessage = (names: string[]) => {
  const q = names.slice(0, 5).map((n) => `"${n}"`);
  const rest = names.length - q.length;
  if (rest > 0) q.push(`${rest} more`);
  const list = q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}` : q[0];
  return `\\includeonly leaves ${list} out of the PDF. Take the \\includeonly line out to build the whole paper, or take out the \\include lines of what is not meant to be in it.`;
};

/** What the paper has that its last good build never opened, and the ZIP that leaves it out. */
export const unusedMessage = (paths: string[]) => {
  const named = paths.slice(0, 10).join(', ');
  const rest = paths.length - 10;
  return `The last build never opened ${named}${rest > 0 ? ` and ${rest} more` : ''}. ${paths.length === 1 ? 'It is' : 'They are'} in the ZIP, and left out of the ZIP of only the files the paper uses.`;
};

/**
 * The data files the paper reads (a table, a CSV, a plot's data) that are held back from
 * downloads. The ZIP leaves them out, so it would not build elsewhere.
 */
export async function heldDataRead(
  pool: pg.Pool,
  store: BlobStore,
  projectId: string,
): Promise<{ fileId: string; path: string; from: string; fromId: string }[]> {
  const held = new Map<string, string>(
    (
      await pool.query(
        `select f.id, f.path from datasets d join files f on f.id = d.file_id
         where d.project_id = $1 and not d.exported`,
        [projectId],
      )
    ).rows.map((r) => [r.path, r.id]),
  );
  if (!held.size) return [];
  const files = await texFiles(pool, store, projectId);
  const root = files.find((f) => f.root);
  if (!root) return [];
  const paths: string[] = (
    await pool.query('select path from files where project_id = $1', [projectId])
  ).rows.map((r) => r.path);
  const graph = includeGraph(
    Object.fromEntries(files.map((f) => [f.path, f.text])),
    root.path,
    paths,
  );
  const out = new Map<string, { fileId: string; path: string; from: string; fromId: string }>();
  for (const e of graph.edges) {
    const fileId = held.get(e.to);
    if (fileId && !out.has(e.to))
      out.set(e.to, {
        fileId,
        path: e.to,
        from: e.from,
        fromId: files.find((f) => f.path === e.from)!.id,
      });
  }
  return [...out.values()];
}

/** The same, for a person who may read the paper. */
export async function heldDataReadBy(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
) {
  await authorize(pool, userId, id(projectId), 'project.read');
  return heldDataRead(pool, store, projectId);
}

/** How long a build may wait before it is taken not to be being built. */
export const BUILD_STUCK_MS = 120_000;

export const submissionChecks = (
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<Submission> => inScope(() => checksOf(pool, store, userId, projectId));

async function checksOf(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<Submission> {
  await authorize(pool, userId, id(projectId), 'project.read');
  // The reports read the same files and ask the same questions; in this scope they share
  // the answers, and wait for the database together.
  const [builds, files, pathRows, labels, cited, held, charts] = await Promise.all([
    latestBuilds(pool, userId, projectId),
    texFiles(pool, store, projectId),
    pool.query('select path from files where project_id = $1', [projectId]),
    labelReport(pool, store, userId, projectId),
    citationReport(pool, store, userId, projectId),
    heldDataRead(pool, store, projectId),
    listCharts(pool, store, userId, projectId),
  ]);
  const findings: Finding[] = [];
  const problem = (kind: Finding['kind'], message: string, where: Partial<Finding> = {}) =>
    findings.push({ level: 'problem', kind, message, ...where });
  const warning = (kind: Finding['kind'], message: string, where: Partial<Finding> = {}) =>
    findings.push({ level: 'warning', kind, message, ...where });

  // What TeX itself said about the newest build decides what reading the paper cannot: a macro
  // can make a label, a file can come from the installation. Only a build that is of the paper
  // as it stands, and that succeeded, is asked.
  const { latest } = builds;
  const queued = latest?.status === 'queued';
  const fresh = !!latest && !queued && !latest.stale && latest.status === 'succeeded';
  const unresolved = { citation: new Set<string>(), label: new Set<string>() };
  const notFound: string[] = [];
  // Labels TeX itself says it defined twice (cleveref adds a second warning, "key@cref").
  const multiply = new Set<string>();
  for (const d of fresh ? latest.diagnostics : []) {
    const dup = MULTIPLY.exec(d.message);
    if (dup) multiply.add(dup[1].replace(/@cref$/, ''));
    const undef = UNDEFINED.exec(d.message);
    if (undef) unresolved[undef[1] === 'Citation' ? 'citation' : 'label'].add(undef[2]);
    const gone = NOT_FOUND.exec(d.message);
    if (gone) notFound.push(gone[1]);
  }
  // The keys the reading of the paper has already reported, so TeX's account does not repeat them.
  const reported = new Set<string>();

  const root = files.find((f) => f.root);
  const paths: string[] = pathRows.rows.map((r) => r.path);
  const used = new Set<string>();
  if (!root) problem('root', 'The paper has no root file to build.');
  else {
    const texts = Object.fromEntries(files.map((f) => [f.path, f.text]));
    const via = await graphicsFolders(pool, store, projectId, root.path, paths);
    const graph = includeGraph(texts, root.path, paths, via);
    for (const edge of graph.edges) used.add(edge.to);
    const place = (from: string, at?: number) => {
      const file = files.find((f) => f.path === from)!;
      return {
        fileId: file.id,
        path: from,
        ...(at === undefined ? {} : { line: file.text.slice(0, at).split('\n').length }),
      };
    };
    for (const m of graph.missing) {
      // With a good build in hand, a file the build did not miss was found by LaTeX elsewhere.
      if (fresh && !notFound.some((n) => namesTarget(n, m.target)))
        warning(
          'file',
          `"${m.target}" is not among the paper's files; LaTeX found it elsewhere.`,
          place(m.from, m.at),
        );
      else
        problem(
          'file',
          m.near
            ? `The paper has no file "${m.target}". It has "${m.near}": only the capital letters differ, and they count here. Change the name to match.`
            : `The paper has no file "${m.target}".`,
          place(m.from, m.at),
        );
    }
    for (const d of graph.dynamic)
      warning(
        'file',
        `"${d.target}" is put together by a macro, so it could not be checked.`,
        place(d.from),
      );
    const out = leftOut(texts, root.path, graph.order);
    if (out) problem('file', leftOutMessage(out.names), place(root.path, out.at));
  }

  const at = (p: { fileId: string; path: string; line: number }) => ({
    fileId: p.fileId,
    path: p.path,
    line: p.line,
  });
  for (const r of labels.undefined)
    if (fresh && !unresolved.label.has(r.key))
      warning(
        'label',
        `\\${r.command}{${r.key}} could not be found by reading the paper; LaTeX resolved it.`,
        at(r),
      );
    else {
      reported.add(`label:${r.key}`);
      problem(
        'label',
        `\\${r.command}{${r.key}} refers to a label the paper does not have.`,
        at(r),
      );
    }
  for (const d of labels.duplicates)
    if (fresh && !multiply.has(d.key))
      warning(
        'label',
        `The label "${d.key}" is written ${d.places.length} times; LaTeX defined it once.`,
        at(d.places[1]),
      );
    else {
      reported.add(`label:${d.key}`);
      problem('label', `The label "${d.key}" is given ${d.places.length} times.`, at(d.places[1]));
    }
  for (const m of cited.missing)
    if (fresh && !unresolved.citation.has(m.key))
      warning(
        'citation',
        `\\${m.command}{${m.key}} could not be found by reading the paper; LaTeX resolved it.`,
        at(m),
      );
    else {
      reported.add(`citation:${m.key}`);
      problem('citation', `\\${m.command}{${m.key}} cites a key no bibliography entry has.`, at(m));
    }
  for (const d of cited.duplicates)
    warning(
      'citation',
      `${d.places.length} bibliography entries have the key "${d.key}".`,
      at(d.places[1]),
    );

  // The ZIP leaves held data out, so a paper that reads it would not build from the ZIP.
  for (const h of held)
    problem('file', heldReadMessage(h.path), { fileId: h.fromId, path: h.from });

  // Files the build that is of the paper as it stands never opened: a cover letter, an old
  // draft. Nothing is wrong with them being there; the ZIP of only the used files leaves them out.
  if (fresh && latest.revisionId) {
    const unused = await unusedInRevision(pool, userId, projectId, latest.revisionId);
    if (unused.length) warning('file', unusedMessage(unused));
  }

  // A chart the paper shows must be drawn from the data as it is now.
  for (const c of charts) {
    if (!used.has(chartPath(c.name, 'pdf')) && !used.has(chartPath(c.name, 'png'))) continue;
    if (c.stale)
      problem(
        'chart',
        `The chart "${c.name}" is out of date: ${
          c.changed === 'settings'
            ? 'the paper holds a drawing made with other settings. Draw it again.'
            : 'its data has changed.'
        }`,
        { chartId: c.id },
      );
    else if (c.status !== 'drawn')
      problem(
        'chart',
        c.status === 'failed'
          ? `The chart "${c.name}" could not be drawn.`
          : `The chart "${c.name}" is waiting to be drawn.`,
        { chartId: c.id },
      );
  }

  // Review that is not finished does not stop a paper being sent, but its author should know.
  const waiting = (
    await pool.query(
      `select ${openThreadsSql('$1')} as threads, ${openProposalsSql('$1')} as proposals`,
      [projectId],
    )
  ).rows[0];
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (waiting.proposals)
    warning(
      'review',
      `${count(waiting.proposals, 'proposed change has', 'proposed changes have')} not been decided.`,
    );
  if (waiting.threads)
    warning('review', `${count(waiting.threads, 'thread is', 'threads are')} still open.`);

  // A build takes a minute at most once it starts. One that has waited twice that is not
  // being built: the page stops looking again by itself, and says so.
  const stuck =
    !!latest && queued && Date.now() - new Date(latest.createdAt).getTime() > BUILD_STUCK_MS;
  const building = queued && !stuck;
  if (!latest) problem('build', 'The paper has not been built yet.');
  else if (stuck)
    problem(
      'build',
      'A build of the paper has been waiting for more than two minutes. The build service may be busy or not running.',
    );
  else if (building) problem('build', 'The paper is being built. Look again in a moment.');
  else if (latest.stale) problem('build', 'The paper has changed since it was last built.');
  if (latest && !queued) {
    const fileOf = (path?: string) => files.find((f) => f.path === path)?.id;
    for (const d of latest.diagnostics) {
      const where = { path: d.file, line: d.line, fileId: fileOf(d.file) };
      // TeX's own word that a key is unresolved is a problem, though it only warns: the PDF
      // shows [?] or ??. The reading of the paper may have said so already.
      const named = fresh ? (UNDEFINED.exec(d.message) ?? MULTIPLY.exec(d.message)) : null;
      if (named) {
        const kind = named[1] === 'Citation' ? 'citation' : 'label';
        const key = named.at(-1)!.replace(/@cref$/, '');
        if (!reported.has(`${kind}:${key}`)) problem(kind, d.message, where);
        continue;
      }
      // The PDF has a box where the picture should be, or lacks characters, or a reference lacks a field its .bib names by an undefined abbreviation, though the build
      // said nothing is wrong.
      if (
        fresh &&
        (PICTURE.test(d.message) ||
          MISSING.test(d.message) ||
          ABBREVIATION.test(d.message) ||
          NOT_MADE.test(d.message))
      ) {
        problem('file', d.message, where);
        continue;
      }
      const noBib = latest.status === 'succeeded' ? NO_BIB.exec(d.message) : null;
      if (noBib) {
        warning('compiler', readyMadeMessage(noBib[1]), where);
        continue;
      }
      if (d.severity === 'error') problem('compiler', d.message, where);
      else warning('compiler', d.message, where);
    }
    if (latest.status === 'failed' && !latest.diagnostics.some((d) => d.severity === 'error'))
      problem(
        'build',
        latest.timedOut ? 'The last build ran out of time.' : 'The last build failed.',
      );
  }
  const ready = !findings.some((f) => f.level === 'problem');
  return { findings, ready, revisionId: ready ? latest!.revisionId : null, building };
}
