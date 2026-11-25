// Numbers for the people who run the service: how builds are queueing, how many edits were
// refused, how often people connect. Counts only, never text. Served by the sync server at
// /metrics, in the Prometheus text format, to whoever holds METRICS_TOKEN.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildHealth, productMetrics } from '@paperweave/server';
import type pg from 'pg';

/** What the sync server counts since it started. */
export const newCounts = () => ({
  connections: 0,
  disconnections: 0,
  refusedConnections: 0,
  editsSaved: 0,
  editsRejected: 0,
  editsTooLarge: 0,
  editsOverBudget: 0,
  editsOffTheOpenCopy: 0,
  presenceDropped: 0,
  commandsApplied: 0,
  commandsNotApplied: 0,
  compactions: 0,
});
export type Counts = ReturnType<typeof newCounts>;

const HELP: Record<keyof Counts, string> = {
  connections: 'Connections to a file that were let in. A reconnect counts again.',
  disconnections: 'Connections to a file that ended.',
  refusedConnections: 'Connections refused: bad ticket, or not on the paper.',
  editsSaved: 'Edits appended to a file log.',
  editsRejected: 'Edits refused because their author may not write to the file.',
  editsTooLarge: 'Edits refused for their size, or for the size they would make the file.',
  editsOverBudget:
    'Edits and structural edits refused because their author had made too many lately.',
  editsOffTheOpenCopy:
    'Edits saved from a connection no longer on the open copy of its file, and passed on to it.',
  presenceDropped:
    'Presence messages (cursors, names) refused or cut down: too large, too many lately, or with more than one person in them.',
  commandsApplied: 'Structural edits applied.',
  commandsNotApplied: 'Structural edits not applied: stale, repeated, refused or malformed.',
  compactions: 'File logs rewritten as one entry.',
};
const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export async function metricsText(pool: pg.Pool, counts: Counts, open: number) {
  const builds = await buildHealth(pool);
  const lines: string[] = [];
  const put = (
    name: string,
    type: 'counter' | 'gauge',
    help: string,
    value: number,
    labels = '',
  ) => {
    if (!lines.some((l) => l.startsWith(`# TYPE ${name} `)))
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    lines.push(`${name}${labels} ${value}`);
  };
  for (const key of Object.keys(counts) as (keyof Counts)[])
    put(`paperweave_sync_${snake(key)}_total`, 'counter', HELP[key], counts[key]);
  put('paperweave_sync_connections_open', 'gauge', 'Connections to files open now.', open);
  put('paperweave_builds_queued', 'gauge', 'Builds waiting for a worker.', builds.queued);
  put(
    'paperweave_build_queue_age_seconds',
    'gauge',
    'How long the oldest waiting build has waited.',
    builds.oldestQueuedSeconds,
  );
  const hour = 'Builds finished in the last hour, by how they ended.';
  put('paperweave_builds_last_hour', 'gauge', hour, builds.succeeded, '{result="succeeded"}');
  put('paperweave_builds_last_hour', 'gauge', hour, builds.failed, '{result="failed"}');
  put('paperweave_builds_last_hour', 'gauge', hour, builds.timedOut, '{result="timed_out"}');
  // How papers fare. Labels are a template's name or a status, never anything from a paper.
  const product = await productMetrics(pool);
  for (const p of product.papers) {
    const origin = `origin="${p.origin}"`;
    put('paperweave_papers', 'gauge', 'Papers, by how they began.', p.papers, `{${origin}}`);
    const got = 'Papers downloaded at least once, by how they began and as what.';
    put('paperweave_papers_downloaded', 'gauge', got, p.downloadedZip, `{${origin},kind="zip"}`);
    put('paperweave_papers_downloaded', 'gauge', got, p.downloadedPdf, `{${origin},kind="pdf"}`);
  }
  put('paperweave_papers_edited', 'gauge', 'Papers someone has edited.', product.edited);
  put(
    'paperweave_papers_two_authors',
    'gauge',
    'Papers at least two people have edited.',
    product.twoAuthors,
  );
  for (const p of product.proposals)
    put(
      'paperweave_proposals',
      'gauge',
      'Proposed changes, by where they came from and what became of them.',
      p.count,
      `{origin="${p.origin}",status="${p.status}"}`,
    );
  for (const g of product.grammar)
    put(
      'paperweave_grammar_suggestions',
      'gauge',
      'Grammar checker findings, by kind and what was done with them.',
      g.count,
      `{kind="${g.kind}",outcome="${g.outcome}"}`,
    );
  return lines.join('\n') + '\n';
}

/**
 * Answer a plain HTTP request to the sync server. Returns true if it was for /metrics and has
 * been answered. With no token set the page does not exist.
 */
export async function serveMetrics(
  request: IncomingMessage,
  response: ServerResponse,
  token: string | undefined,
  text: () => Promise<string>,
) {
  if (request.url?.split('?')[0] !== '/metrics') return false;
  const given = Buffer.from(/^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '');
  const want = Buffer.from(token ?? '');
  const ok = !!token && given.length === want.length && timingSafeEqual(given, want);
  if (!ok) {
    response.writeHead(token ? 401 : 404, { 'content-type': 'text/plain' });
    response.end(token ? 'A token is needed.\n' : 'Not found.\n');
    return true;
  }
  response.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4',
    'cache-control': 'no-store',
  });
  response.end(await text());
  return true;
}
