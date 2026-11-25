import {
  AppError,
  can,
  diffRevisions,
  heldInRevisions,
  heldLine,
  listRevisions,
  listVersions,
  MAX_VERSIONS,
  olderAutoRevisions,
  REVISIONS_SHOWN,
  revisionStats,
  versionOf,
  withScope,
  type Revision,
  type RevisionStat,
  type Version,
} from '@paperweave/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppBar } from '../../../../components/app-bar';
import { FileDiffs } from '../../../../components/file-diffs';
import { Flag, GitBranch, GitMerge, Icon, Pencil, RotateCcw } from '../../../../components/icon';
import { LookProvider } from '../../../../components/look';
import { ThemeSwitch } from '../../../../components/theme-switch';
import { VersionMenu } from '../../../../components/version-menu';
import { buttonVariants } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import { OverlayRoot } from '../../../../components/ui/overlay-root';
import { called, NOW, since } from '../../../../lib/compare';
import { blobs, db, forTitle, paperOf, requireUser } from '../../../../lib/server';
import { switcherOf, versionPowers, versionsOn } from '../../../../lib/versions';
import { timeline, type TimelineRevision, type TimelineRow } from '../../../../lib/timeline';
import Link from '../../../Go';
import Once from '../../../Once';
import Result from '../../../Result';
import {
  buildHistoryAction,
  compareHistoryAction,
  deleteVersionAction,
  nameRevisionAction,
  renameVersionAction,
  restoreHistoryAction,
  saveNamedAction,
  startVersionAction,
} from './actions';
import {
  CompareProvider,
  CompareToggle,
  ComparePicker,
  RestoreButton,
  RowMenu,
  RunShow,
  StartVersionButton,
  VersionMenuRow,
} from './Client';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clock = (d: Date | string) => new Date(d).toISOString().slice(11, 16);

/** "212 words added, 64 removed in 3 files", or nothing while the revision has not been counted. */
function statLine(stat: RevisionStat | null | undefined): string {
  if (!stat) return '';
  const at = stat.partial ? 'At least ' : '';
  if (stat.files === 0) return 'Nothing changed in the files.';
  if (!stat.added && !stat.removed) return `${plural(stat.files, 'file')} changed.`;
  return `${at}${plural(stat.added, 'word')} added, ${stat.removed} removed in ${plural(stat.files, 'file')}`;
}

function dayName(day: string, today: string) {
  if (day === today) return 'Today';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await forTitle((userId) => paperOf(userId, id));
  return { title: project ? `History · ${project.name}` : 'History' };
}

type Query = {
  error?: string;
  saved?: string;
  named?: string;
  restored?: string;
  building?: string;
  before?: string;
  from?: string;
  to?: string;
  started?: string;
  version?: string;
  renamed?: string;
  deleted?: string;
};

async function History({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Query>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requireUser(`/projects/${id}/history`);
  const asked = Number(query.before);
  const olderThan = Number.isInteger(asked) && asked > 0 ? asked : undefined;
  const [project, listed] = await Promise.all([
    paperOf(user.id, id),
    listRevisions(db(), user.id, id, { autos: REVISIONS_SHOWN, before: olderThan }),
  ]).catch((err) => {
    // Not a member, or no such paper: the two look the same from outside.
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  const writer = can(project.role, 'revision.write');
  const exporter = can(project.role, 'project.export');
  const builder = can(project.role, 'build.run');
  // Versions: only with the setting on. Off, none of these is asked and nothing of them is drawn.
  const versionsShown = versionsOn();
  const powers = versionPowers(project.role);
  const versions: Version[] = versionsShown ? await listVersions(db(), user.id, id) : [];
  const here = versionsShown ? await versionOf(db(), id) : null;
  const mainId = here ? (versions[0]?.paper ?? id) : id;
  const beganAt = (revisionId: string) => versions.filter((v) => v.base?.id === revisionId);
  const ids = listed.map((r) => r.id);
  const stats = await revisionStats(db(), blobs(), user.id, id, ids);
  const revisions: Revision[] = listed.map((r) => ({ ...r, stat: stats.get(r.id) ?? r.stat }));
  const held = await heldInRevisions(db(), user.id, id, ids);
  const oldestAuto = revisions.findLast((r) => r.kind === 'auto')?.number;
  const olderAutos = oldestAuto ? await olderAutoRevisions(db(), user.id, id, oldestAuto) : 0;
  const byId = new Map(revisions.map((r) => [r.id, r]));
  const byNumber = new Map(revisions.map((r) => [r.number, r]));

  // The comparison in the address, if there is one.
  const [from, to] = [query.from, query.to];
  const comparing = from && to && UUID.test(from) && UUID.test(to);
  let diff: Awaited<ReturnType<typeof diffRevisions>> | null = null;
  let refused = '';
  if (comparing)
    diff = await diffRevisions(db(), blobs(), user.id, id, from, to).catch((err) => {
      if (err instanceof AppError && err.code === 'not_found') {
        refused = 'No such revision to compare.';
        return null;
      }
      throw err;
    });

  const days = timeline(revisions as TimelineRevision[], { timeZone: 'UTC' });
  const today = new Date().toISOString().slice(0, 10);
  const comparable = revisions.length >= 2;

  const actionsOf = (r: Revision) => ({
    restore: writer ? restoreHistoryAction.bind(null, id, r.id) : undefined,
    name: writer ? nameRevisionAction.bind(null, id, r.id) : undefined,
    build: !r.hasPdf && builder ? buildHistoryAction.bind(null, id, r.id) : undefined,
    // One level: a version is not itself the start of versions.
    version:
      versionsShown && powers.start && !here ? startVersionAction.bind(null, id, r.id) : undefined,
  });
  /** "camera-ready began here": the versions that were started at this revision. */
  const began = (r: Revision) =>
    beganAt(r.id).map((v) => (
      <small key={v.id} className="history-note history-began">
        <Icon icon={GitBranch} /> The version{' '}
        <Link prefetch={false} href={`/projects/${v.id}/history`}>
          {v.name}
        </Link>{' '}
        began here
      </small>
    ));
  const menu = (r: Revision) => (
    <RowMenu
      number={r.number}
      name={r.name}
      zip={exporter ? `/projects/${id}/revisions/${r.id}/zip` : null}
      pdf={r.hasPdf ? `/projects/${id}/revisions/${r.id}/pdf` : null}
      actions={actionsOf(r)}
    />
  );
  const heldOf = (r: Revision) => {
    const line = exporter ? heldLine(held.get(r.id) ?? []) : '';
    return line ? <small className="history-note">{line}</small> : null;
  };
  const made = (r: Revision) =>
    `${clock(r.createdAt)} UTC${r.createdBy ? `, by ${r.createdBy}` : ''}`;

  const named = (row: Extract<TimelineRow, { type: 'named' | 'restore' | 'merge' }>) => {
    const r = row.revision as Revision;
    const kept = row.type === 'restore' ? byNumber.get(r.number - 1) : undefined;
    return (
      <li key={row.id} className={`history-row history-${row.type}`}>
        <span className="history-dot" aria-hidden="true">
          <Icon
            icon={row.type === 'restore' ? RotateCcw : row.type === 'merge' ? GitMerge : Flag}
          />
        </span>
        <div className="history-body">
          <p className="history-title">
            <span className="history-name">
              {r.name ??
                (r.kind === 'restore' ? `Restore of revision ${r.restoredFrom}` : 'Unnamed')}
            </span>{' '}
            <span className="history-number">Revision {r.number}</span>
          </p>
          <p>{made(r)}</p>
          {row.type === 'restore' && r.number > 1 && (
            <p>
              The paper as it was is revision {r.number - 1}.{' '}
              {kept && (
                <Link prefetch={false} href={`/projects/${id}/revisions/${r.id}/diff/${kept.id}`}>
                  Compare with what it replaced
                </Link>
              )}
            </p>
          )}
          {statLine(r.stat) && <p>{statLine(r.stat)}</p>}
          {r.hasPdf && <p>PDF built.</p>}
          {heldOf(r)}
          {began(r)}
        </div>
        <div className="history-acts">
          {comparable && <CompareToggle id={r.id} number={r.number} />}
          {menu(r)}
        </div>
      </li>
    );
  };

  const run = (row: Extract<TimelineRow, { type: 'run' }>) => {
    const rs = row.revisions as Revision[];
    const added = rs.reduce((n, r) => n + (r.stat?.added ?? 0), 0);
    const removed = rs.reduce((n, r) => n + (r.stat?.removed ?? 0), 0);
    return (
      <li key={row.id} className="history-row history-run">
        <span className="history-dot" aria-hidden="true" />
        <div className="history-body">
          <p className="history-title">{plural(row.count, 'automatic revision')}</p>
          <p>
            {row.count > 1 ? `${clock(row.from)} to ${clock(row.to)} UTC` : `${clock(row.to)} UTC`}
            {row.authors.length ? `, by ${row.authors.join(' and ')}` : ''}
          </p>
          {(added > 0 || removed > 0) && (
            <p>
              {plural(added, 'word')} added, {removed} removed
            </p>
          )}
        </div>
        <RunShow count={row.count}>
          {rs.map((r) => (
            <li key={r.id} className="history-row history-auto">
              <div className="history-body">
                <p className="history-title">
                  <span className="history-number">Revision {r.number}</span>
                </p>
                <p>{made(r)}</p>
                {statLine(r.stat) && <p>{statLine(r.stat)}</p>}
                {heldOf(r)}
                {began(r)}
              </div>
              <div className="history-acts">
                {comparable && <CompareToggle id={r.id} number={r.number} />}
                {menu(r)}
              </div>
            </li>
          ))}
        </RunShow>
      </li>
    );
  };

  const said: ReactNode[] = [];
  if (query.error)
    said.push(
      <Result key="e" alert>
        {query.error}
      </Result>,
    );
  if (refused)
    said.push(
      <Result key="r" alert>
        {refused}
      </Result>,
    );
  if (query.saved) said.push(<Result key="s">Saved as revision {query.saved}.</Result>);
  if (query.named) said.push(<Result key="n">Revision {query.named} has a name now.</Result>);
  if (versionsShown && query.started)
    said.push(
      <Result key="v">
        Started the version “{query.started}”.{' '}
        {query.version && UUID.test(query.version) && (
          <Link prefetch={false} href={`/projects/${query.version}`}>
            Open the version
          </Link>
        )}
      </Result>,
    );
  if (versionsShown && query.renamed)
    said.push(<Result key="rn">The version is now called “{query.renamed}”.</Result>);
  if (versionsShown && query.deleted)
    said.push(<Result key="d">Deleted the version “{query.deleted}”.</Result>);
  if (query.restored)
    said.push(<Result key="t">Restored. The paper is now revision {query.restored}.</Result>);
  if (query.building)
    said.push(<Result key="b">Building the PDF for that revision. Reload in a moment.</Result>);

  const saveForm = writer && (
    <form action={saveNamedAction.bind(null, id)} className="history-save">
      <Label htmlFor="history-name">Name for the new revision</Label>
      <div>
        <Input
          id="history-name"
          name="name"
          required
          maxLength={200}
          placeholder="Submitted to the workshop"
        />
        <Once>Save a named revision</Once>
      </div>
    </form>
  );

  return (
    <main data-ui="next" className="page history">
      <LookProvider look="next">
        <OverlayRoot>
          <AppBar
            home="/projects"
            crumbs={[
              { id: 'paper', label: project.name, href: `/projects/${id}` },
              { id: 'history', label: 'History', heading: true },
            ]}
          >
            {versionsShown && (
              <VersionMenu
                choices={switcherOf(mainId, versions, id)}
                page="/history"
                paper={mainId}
                merge={powers.merge}
              />
            )}
            <Link
              prefetch={false}
              href={`/projects/${id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Paper overview
            </Link>
            <ThemeSwitch />
          </AppBar>
          <CompareProvider>
            <div className="history-grid">
              <div className="history-side">
                {versionsShown && (
                  <section
                    id="versions"
                    aria-labelledby="history-versions"
                    className="history-versions"
                  >
                    <h2 id="history-versions">Versions</h2>
                    <p>
                      A version is a copy of the paper that is edited apart. The paper itself is
                      called main.
                    </p>
                    <ul className="history-vlist">
                      <li className="history-vrow">
                        <span className="history-vname">
                          <Link
                            prefetch={false}
                            href={`/projects/${mainId}/history`}
                            aria-current={here ? undefined : 'page'}
                          >
                            main
                          </Link>
                          {!here && (
                            <span className="history-vnote"> You are looking at this one.</span>
                          )}
                        </span>
                      </li>
                      {versions.map((v) => (
                        <li key={v.id} className="history-vrow">
                          <span className="history-vname">
                            <Link
                              prefetch={false}
                              href={`/projects/${v.id}/history`}
                              aria-current={v.id === id ? 'page' : undefined}
                            >
                              {v.name}
                            </Link>
                            {v.id === id && (
                              <span className="history-vnote"> You are looking at this one.</span>
                            )}
                            <small className="history-vnote">
                              {v.base
                                ? `Began at revision ${v.base.number}`
                                : 'Began at an early revision'}
                              {v.createdBy ? `, by ${v.createdBy}` : ''}, {v.createdAt.slice(0, 10)}
                            </small>
                          </span>
                          <VersionMenuRow
                            name={v.name}
                            merge={
                              powers.merge
                                ? `/projects/${mainId}/versions/${v.id}/merge`
                                : undefined
                            }
                            rename={
                              powers.rename ? renameVersionAction.bind(null, id, v.id) : undefined
                            }
                            remove={
                              powers.delete
                                ? deleteVersionAction.bind(null, id, v.id, mainId)
                                : undefined
                            }
                          />
                        </li>
                      ))}
                    </ul>
                    {versions.length === 0 && <p>This paper has no versions yet.</p>}
                    <p className="history-vnote">
                      {plural(versions.length, 'version')} of at most {MAX_VERSIONS}.
                    </p>
                    {powers.start && !here && (
                      <StartVersionButton action={startVersionAction.bind(null, id, NOW)} />
                    )}
                  </section>
                )}
                <section aria-labelledby="history-timeline" className="history-line">
                  <h2 id="history-timeline">Revisions</h2>
                  {said.length > 0 && <div className="history-said">{said}</div>}
                  {revisions.length === 0 ? (
                    <div className="history-empty">
                      <p>
                        No revisions yet. One is made each time the PDF is built. Save one under a
                        name to find it again.
                      </p>
                      {saveForm}
                    </div>
                  ) : (
                    <>
                      {saveForm}
                      {writer && (
                        <p className="history-now">
                          <Icon icon={Pencil} /> The paper as it is now. The newest revision is
                          revision {revisions[0].number}.
                        </p>
                      )}
                      <ol className="history-days">
                        {days.map((d) => (
                          <li key={d.day} className="history-day">
                            <h3>{dayName(d.day, today)}</h3>
                            <ol>
                              {d.rows.map((row) => (row.type === 'run' ? run(row) : named(row)))}
                            </ol>
                          </li>
                        ))}
                      </ol>
                      {(olderAutos > 0 || olderThan) && (
                        <p className="history-more">
                          {olderThan
                            ? `These are revisions from before revision ${olderThan}. `
                            : `Every revision that was named or restored is listed, and the newest ${REVISIONS_SHOWN} made automatically. `}
                          {olderAutos > 0 && (
                            <Link
                              prefetch={false}
                              href={`/projects/${id}/history?before=${oldestAuto}`}
                            >
                              {olderAutos === 1
                                ? 'One older automatic revision'
                                : `${olderAutos} older automatic revisions`}
                            </Link>
                          )}{' '}
                          {olderThan && (
                            <Link prefetch={false} href={`/projects/${id}/history`}>
                              Back to the newest
                            </Link>
                          )}
                        </p>
                      )}
                    </>
                  )}
                </section>
              </div>
              <section id="comparison" aria-labelledby="history-compare" className="history-sheet">
                <h2 id="history-compare">Comparison</h2>
                {comparable ? (
                  <ComparePicker
                    action={compareHistoryAction.bind(null, id)}
                    options={revisions.map((r) => ({ id: r.id, label: called(r) }))}
                    now={writer ? NOW : null}
                    from={comparing && byId.has(from) ? from : since(revisions, writer)}
                    to={comparing && byId.has(to) ? to : writer ? NOW : revisions[0].id}
                  />
                ) : (
                  <p>
                    {revisions.length === 0
                      ? 'Nothing to compare yet.'
                      : 'There is one revision, so there is nothing to compare it with yet.'}
                  </p>
                )}
                {diff && from && (
                  <div className="history-diff">
                    <h3>
                      Revision {diff.from} to revision {diff.to}
                    </h3>
                    {diff.files.length === 0 && <p>Nothing differs between these two revisions.</p>}
                    <FileDiffs id={id} diff={diff} other={from} rev={to!} Heading="h4" />
                    {writer && (
                      <RestoreButton
                        number={diff.from}
                        action={restoreHistoryAction.bind(null, id, from)}
                      />
                    )}
                  </div>
                )}
              </section>
            </div>
          </CompareProvider>
        </OverlayRoot>
      </LookProvider>
    </main>
  );
}

export default function Scoped(props: Parameters<typeof History>[0]) {
  return withScope(() => History(props));
}
