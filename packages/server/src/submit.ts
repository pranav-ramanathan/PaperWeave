// What stands between the paper as it is and a paper that can be sent: everything the service
// already knows is wrong with it, gathered in one place.
import { includeGraph } from '@paperweave/latex';
import type pg from 'pg';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { latestBuilds } from './builds.ts';
import { chartPath, listCharts } from './charts.ts';
import { citationReport } from './citations.ts';
import { labelReport, texFiles } from './labels.ts';
import { id } from './projects.ts';

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
const NOT_FOUND = /[`'](.+?)' not found/;
/** Whether a file TeX could not find ("nosuchfile.tex") is the one a command named ("nosuchfile"). */
const namesTarget = (found: string, target: string) => {
  const bare = (p: string) => p.replace(/^\.\//, '').replace(/\.[a-z0-9]+$/i, '');
  return found === target || bare(found) === bare(target);
};

/** How long a build may wait before it is taken not to be being built. */
export const BUILD_STUCK_MS = 120_000;

export async function submissionChecks(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<Submission> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const findings: Finding[] = [];
  const problem = (kind: Finding['kind'], message: string, where: Partial<Finding> = {}) =>
    findings.push({ level: 'problem', kind, message, ...where });
  const warning = (kind: Finding['kind'], message: string, where: Partial<Finding> = {}) =>
    findings.push({ level: 'warning', kind, message, ...where });

  // What TeX itself said about the newest build decides what reading the paper cannot: a macro
  // can make a label, a file can come from the installation. Only a build that is of the paper
  // as it stands, and that succeeded, is asked.
  const { latest } = await latestBuilds(pool, userId, projectId);
  const queued = latest?.status === 'queued';
  const fresh = !!latest && !queued && !latest.stale && latest.status === 'succeeded';
  const unresolved = { citation: new Set<string>(), label: new Set<string>() };
  const notFound: string[] = [];
  for (const d of fresh ? latest.diagnostics : []) {
    const undef = UNDEFINED.exec(d.message);
    if (undef) unresolved[undef[1] === 'Citation' ? 'citation' : 'label'].add(undef[2]);
    const gone = NOT_FOUND.exec(d.message);
    if (gone) notFound.push(gone[1]);
  }
  // The keys the reading of the paper has already reported, so TeX's account does not repeat them.
  const reported = new Set<string>();

  const files = await texFiles(pool, store, projectId);
  const root = files.find((f) => f.root);
  const paths: string[] = (
    await pool.query('select path from files where project_id = $1', [projectId])
  ).rows.map((r) => r.path);
  const used = new Set<string>();
  if (!root) problem('root', 'The paper has no root file to build.');
  else {
    const texts = Object.fromEntries(files.map((f) => [f.path, f.text]));
    const graph = includeGraph(texts, root.path, paths);
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
      else problem('file', `The paper has no file "${m.target}".`, place(m.from, m.at));
    }
    for (const d of graph.dynamic)
      warning(
        'file',
        `"${d.target}" is put together by a macro, so it could not be checked.`,
        place(d.from),
      );
  }

  const at = (p: { fileId: string; path: string; line: number }) => ({
    fileId: p.fileId,
    path: p.path,
    line: p.line,
  });
  const labels = await labelReport(pool, store, userId, projectId);
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
  for (const d of labels.duplicates) {
    reported.add(`label:${d.key}`);
    problem('label', `The label "${d.key}" is given ${d.places.length} times.`, at(d.places[1]));
  }
  const cited = await citationReport(pool, store, userId, projectId);
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

  // A chart the paper shows must be drawn from the data as it is now.
  for (const c of await listCharts(pool, store, userId, projectId)) {
    if (!used.has(chartPath(c.name, 'pdf')) && !used.has(chartPath(c.name, 'png'))) continue;
    if (c.stale)
      problem('chart', `The chart "${c.name}" is out of date: its data has changed.`, {
        chartId: c.id,
      });
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
      `select (select count(*)::int from threads t join files f on f.id = t.file_id
                where t.project_id = $1 and t.status = 'open') as threads,
              (select count(*)::int from proposals p join files f on f.id = p.file_id
                where p.project_id = $1 and p.status = 'open') as proposals`,
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
        const key = named.at(-1)!;
        if (!reported.has(`${kind}:${key}`)) problem(kind, d.message, where);
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
