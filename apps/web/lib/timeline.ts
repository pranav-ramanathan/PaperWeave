import type { Revision } from '@paperweave/server';

/**
 * A revision as the history page gets it: `listRevisions`' shape, with what a row may also say.
 * `createdAt` may be a `Date` (the database driver's) or an ISO string. `merge` revisions and
 * `files` (the paths a revision changed, from `revisionStats`) do not exist yet; both are optional.
 */
export type TimelineRevision = Omit<Revision, 'kind' | 'createdAt'> & {
  kind: Revision['kind'] | 'merge';
  createdAt: string | Date;
  /** The paths this revision changed, if known. */
  files?: string[];
};

/** A place where a version began: the revision it was started from, and its name. */
export type VersionStart = { revisionId: string; name: string };

type Common = { id: string; at: Date };

/** One row of the timeline. */
export type TimelineRow =
  | (Common & {
      type: 'named';
      revision: TimelineRevision;
      /** Versions that began at this revision. */
      began: VersionStart[];
    })
  | (Common & {
      type: 'restore' | 'merge';
      revision: TimelineRevision;
      began: VersionStart[];
    })
  | (Common & {
      type: 'run';
      /** The automatic revisions, newest first. */
      revisions: TimelineRevision[];
      count: number;
      /** The oldest and the newest of the run. */
      from: Date;
      to: Date;
      /** Who cut them, each once, in the order of first appearance (newest first). */
      authors: string[];
      /** The paths they changed, each once, sorted. Empty when none is known. */
      files: string[];
      /** Versions that began at one of the run's revisions. */
      began: VersionStart[];
    });

export type TimelineDay = {
  /** The day in the viewer's time zone, `YYYY-MM-DD`. */
  day: string;
  rows: TimelineRow[];
};

/** The day of `at` in `timeZone`, as `YYYY-MM-DD`. */
function dayIn(at: Date, timeZone: string): string {
  // The "sv-SE" locale writes dates as YYYY-MM-DD; it is only used for that shape.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * The timeline of a paper's revisions: days newest first; within a day, rows newest first.
 * Consecutive automatic revisions (by number, so a named revision or restore ends a run) are one
 * `run` row with their count, time range, authors and files; named revisions, restores and merges
 * are rows of their own. A run does not continue across midnight in `timeZone`. `starts` marks the
 * revisions where a version began (each shows on the row holding that revision). The order comes
 * from the revisions' numbers, not from the order given. No clock and no locale are read.
 */
export function timeline(
  revisions: TimelineRevision[],
  opts: { timeZone: string; starts?: VersionStart[] },
): TimelineDay[] {
  const starts = opts.starts ?? [];
  const began = (rs: TimelineRevision[]) =>
    starts.filter((s) => rs.some((r) => r.id === s.revisionId));
  const sorted = [...revisions].sort((a, b) => b.number - a.number);
  const days: TimelineDay[] = [];
  let run: TimelineRevision[] = [];

  const flush = () => {
    if (!run.length) return;
    const times = run.map((r) => new Date(r.createdAt).getTime());
    const files = new Set<string>();
    for (const r of run) for (const f of r.files ?? []) files.add(f);
    const to = new Date(Math.max(...times));
    days.at(-1)!.rows.push({
      type: 'run',
      id: `run-${run[0].number}-${run.at(-1)!.number}`,
      at: to,
      revisions: run,
      count: run.length,
      from: new Date(Math.min(...times)),
      to,
      authors: [...new Set(run.flatMap((r) => (r.createdBy ? [r.createdBy] : [])))],
      files: [...files].sort(),
      began: began(run),
    });
    run = [];
  };

  for (const r of sorted) {
    const at = new Date(r.createdAt);
    const day = dayIn(at, opts.timeZone);
    if (days.at(-1)?.day !== day) {
      flush();
      days.push({ day, rows: [] });
    }
    if (r.kind === 'auto') {
      run.push(r);
      continue;
    }
    flush();
    days.at(-1)!.rows.push({
      type: r.kind,
      id: r.id,
      at,
      revision: r,
      began: began([r]),
    });
  }
  flush();
  return days;
}
