import {
  AppError,
  can,
  diffWords,
  listVersions,
  openReview,
  planMerge,
  type MergePlan,
  type PlanConflict,
  type PlannedFile,
  withScope,
} from '@paperweave/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppBar } from '../../../../../../components/app-bar';
import { KitProvider } from '../../../../../../components/kit';
import { Notice } from '../../../../../../components/notice';
import { buttonVariants } from '../../../../../../components/ui/button';
import { OverlayRoot } from '../../../../../../components/ui/overlay-root';
import { blobs, db, forTitle, paperOf, requireUser } from '../../../../../../lib/server';
import { versionsOn } from '../../../../../../lib/versions';
import Link from '../../../../../Go';
import Once from '../../../../../Once';
import Result from '../../../../../Result';
import { mergeAction } from './actions';
import { OwnText } from './OwnText';

// The merge page (PLAN.md section 14.2): a version into main, or main into the version to bring it
// up to date. It is a plain form that posts without scripts. The page works out the plan again at
// each look (the plan is a pure function of three revisions, so it can be reloaded and shared) and
// names those three revisions in the form, so the action applies what was shown. In the new look
// only, like the history page: it has no classic version.
export const dynamic = 'force-dynamic';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Query = {
  direction?: string;
  error?: string;
  pick?: string | string[];
  merged?: string;
  kept?: string;
  files?: string;
  decided?: string;
  carried?: string;
  left?: string;
};

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; version: string }>;
  searchParams: Promise<Query>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const project = await forTitle((userId) => paperOf(userId, id));
  const what = query.direction === 'up' ? 'Bring up to date' : 'Merge';
  return { title: project && versionsOn() ? `${what} · ${project.name}` : what };
}

/** The words of one side, with the words that changed since the base marked. */
function Words({ base, text }: { base?: string; text: string }) {
  if (!text) return <em>nothing: this side has no text here</em>;
  const d = base === undefined ? null : diffWords(base, text);
  if (!d) return <>{text}</>;
  return (
    <>
      {d.now.map((p, i) =>
        p.changed ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}

/** What a file of the plan says about itself, in words. */
function fileLine(f: PlannedFile, ours: string, theirs: string): string {
  const renamed = f.renamed ? ` Named ${f.renamed.to}, from ${f.renamed.from}.` : '';
  switch (f.status) {
    case 'kept':
      return f.target
        ? `Changed only on ${ours}. It stays as it is.${f.renamed?.side === 'ours' ? renamed : ''}`
        : `Deleted on ${ours}. It stays deleted.`;
    case 'taken':
      return `Changed only on ${theirs}. ${ours} gets that.${f.renamed?.side === 'theirs' ? renamed : ''}`;
    case 'merged':
      return `Changed on both, and the changes fit together. Merged by themselves.`;
    case 'added':
      return `New on ${theirs}. It is added to ${ours}.`;
    case 'removed':
      return `Deleted on ${theirs}. It is deleted from ${ours}.`;
    case 'conflict':
      return f.conflicts.length === 1
        ? 'Needs you: one decision below.'
        : `Needs you: ${f.conflicts.length} decisions below.`;
    default:
      return '';
  }
}

/** Both sides changed a file that was also renamed differently: the other side's edits stay behind. */
const loses = (f: PlannedFile, c: PlanConflict) =>
  c.kind === 'renamed' &&
  !!c.theirsFile &&
  !!c.oursFile &&
  !!f.base &&
  c.theirsFile.digest !== f.base.digest &&
  c.oursFile.digest !== f.base.digest &&
  c.theirsFile.digest !== c.oursFile.digest;

async function Merge({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; version: string }>;
  searchParams: Promise<Query>;
}) {
  const [{ id, version }, query] = await Promise.all([params, searchParams]);
  const here = `/projects/${id}/versions/${version}/merge`;
  const user = await requireUser(query.direction === 'up' ? `${here}?direction=up` : here);
  if (!versionsOn()) notFound();
  const project = await paperOf(user.id, id).catch((err) => {
    // Not a member, or no such paper: the two look the same from outside.
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  const found = (await listVersions(db(), user.id, id)).find((v) => v.id === version);
  // `id` is main, and the version is one of its versions; a version's own address is not main.
  if (!found || found.paper !== id) notFound();
  const up = query.direction === 'up';
  const writer = can(project.role, 'revision.write');
  const mainName = 'main';
  const versionName = `the version “${found.name}”`;
  const [oursName, theirsName] = up ? [versionName, mainName] : [mainName, versionName];
  const title = up
    ? `Bring “${found.name}” up to date from main`
    : `Merge “${found.name}” into main`;
  const action = up ? 'Bring up to date from main' : 'Merge into main';
  const other = up
    ? { href: here, label: `Merge “${found.name}” into main instead` }
    : { href: `${here}?direction=up`, label: `Bring “${found.name}” up to date from main instead` };

  let plan: MergePlan | null = null;
  let refused = '';
  if (writer)
    plan = await (
      up
        ? planMerge(db(), blobs(), user.id, version, id)
        : planMerge(db(), blobs(), user.id, id, version)
    ).catch((err) => {
      if (err instanceof AppError && err.code === 'not_found') notFound();
      if (err instanceof AppError && err.code !== 'invalid_input') {
        refused = err.message;
        return null;
      }
      throw err;
    });

  const picked = new Map(
    [query.pick ?? []].flat().flatMap((p) => {
      const at = p.lastIndexOf('~');
      return at > 0 ? [[p.slice(0, at), p.slice(at + 1)] as const] : [];
    }),
  );
  const said: ReactNode[] = [];
  if (query.error)
    said.push(
      <Result key="e" alert>
        {query.error}
      </Result>,
    );
  const merged = Number(query.merged);
  if (Number.isInteger(merged) && merged > 0) {
    const [kept, files, decided] = [query.kept, query.files, query.decided].map(Number);
    const [ct, cp, left] = (query.carried ?? '').split('.').map(Number);
    const brought =
      query.carried !== undefined && [ct, cp].every(Number.isInteger)
        ? `Brought across: ${plural(ct, 'comment thread')} and ${plural(cp, 'proposal')}.${
            Number.isInteger(left) && left > 0
              ? ` ${plural(left, 'item')} could not be placed in the merged text and stayed where ${left === 1 ? 'it was' : 'they were'}.`
              : ''
          }`
        : '';
    said.push(
      <Result key="m">
        Merged: {up ? `the version “${found.name}”` : 'main'} is now revision {merged}
        {Number.isInteger(files) && Number.isInteger(decided)
          ? `, with ${plural(files, 'file')} changed and ${plural(decided, 'conflict')} decided`
          : ''}
        .{' '}
        {Number.isInteger(kept) && kept > 0
          ? `The paper as it was is revision ${kept}: restore it on the history page to undo the merge.`
          : ''}{' '}
        {brought}{' '}
        <Link prefetch={false} href={`/projects/${up ? version : id}/history`}>
          See the history
        </Link>
      </Result>,
    );
  }

  // What a merge could bring across: the other side's open comments and proposals.
  const open =
    plan && writer
      ? await (up ? openReview(db(), version, id) : openReview(db(), id, version)).catch(() => null)
      : null;
  const settings = plan
    ? (['root', 'compiler'] as const).map((k) => ({ key: k, ...plan.settings[k] }))
    : [];
  const settingConflicts = settings.filter((s) => s.status === 'conflict');
  const total = (plan?.conflicts.length ?? 0) + settingConflicts.length;
  const listed = plan?.files.filter((f) => f.status !== 'unchanged') ?? [];
  const needs = plan?.files.filter((f) => f.status === 'conflict').length ?? 0;
  const nothing =
    !!plan &&
    listed.every((f) => f.status === 'kept') &&
    settings.every((s) => s.status === 'unchanged' || s.status === 'kept');
  let n = 0;

  const radio = (
    name: string,
    value: string,
    nr: string,
    label: ReactNode,
    extra?: { required?: boolean },
  ) => (
    <label className="merge-choice" htmlFor={`${nr}-${value}`}>
      <input
        type="radio"
        id={`${nr}-${value}`}
        name={`choice:${name}`}
        value={value}
        required={extra?.required ?? true}
        defaultChecked={picked.get(name) === value}
      />
      <span>{label}</span>
    </label>
  );

  const card = (f: PlannedFile, c: PlanConflict) => {
    n += 1;
    const nr = `c${n}`;
    const where = `${c.path}${c.line ? `, line ${c.line}` : ''}`;
    const file = (side: 'oursFile' | 'theirsFile') => c[side]?.path ?? '';
    let body: ReactNode;
    let choices: ReactNode;
    if (c.kind === 'text' && c.textKind !== 'too-large') {
      body = (
        <>
          <div className="merge-sides">
            <figure>
              <figcaption>On {oursName}</figcaption>
              <pre>
                <Words base={c.base} text={c.ours ?? ''} />
              </pre>
            </figure>
            <figure>
              <figcaption>On {theirsName}</figcaption>
              <pre>
                <Words base={c.base} text={c.theirs ?? ''} />
              </pre>
            </figure>
          </div>
          <details>
            <summary>The text before either side changed it</summary>
            <pre>{c.base || 'There was nothing here before.'}</pre>
          </details>
        </>
      );
      choices = (
        <>
          {radio(c.id, 'ours', nr, `Keep the text on ${oursName}`)}
          {radio(c.id, 'theirs', nr, `Take the text on ${theirsName}`)}
          {c.choices.includes('both') &&
            radio(c.id, 'both', nr, `Keep both, the text on ${oursName} first`)}
          {radio(c.id, 'text', nr, 'Write it myself')}
          <div className="merge-own">
            <label htmlFor={`${nr}-own`}>Your text for conflict {n}</label>
            <OwnText
              radio={`${nr}-text`}
              id={`${nr}-own`}
              name={`text:${c.id}`}
              defaultValue={c.ours ?? ''}
              rows={4}
              spellCheck={false}
            />
          </div>
        </>
      );
    } else if (c.kind === 'text') {
      body = (
        <p>
          {c.path} is too large or too changed to merge word by word. Both sides changed it. Choose
          the whole file from one side, or write the whole text yourself.
        </p>
      );
      choices = (
        <>
          {radio(c.id, 'ours', nr, `Keep the file as it is on ${oursName}`)}
          {radio(c.id, 'theirs', nr, `Take the file from ${theirsName}`)}
          {c.choices.includes('text') && radio(c.id, 'text', nr, 'Write it myself')}
          {c.choices.includes('text') && (
            <div className="merge-own">
              <label htmlFor={`${nr}-own`}>Your text for conflict {n}</label>
              <OwnText
                radio={`${nr}-text`}
                id={`${nr}-own`}
                name={`text:${c.id}`}
                defaultValue=""
                rows={4}
                spellCheck={false}
              />
            </div>
          )}
        </>
      );
    } else if (c.kind === 'binary') {
      body = (
        <p>
          {c.path} is not text and was changed on both sides, so the two cannot be put together.
          Choose one file.
        </p>
      );
      choices = (
        <>
          {radio(c.id, 'ours', nr, `Keep the file on ${oursName}`)}
          {radio(c.id, 'theirs', nr, `Take the file from ${theirsName}`)}
        </>
      );
    } else if (c.kind === 'deleted-vs-changed') {
      const oursGone = !c.oursFile;
      body = (
        <p>
          {oursGone
            ? `${c.path} was deleted on ${oursName} and changed on ${theirsName}.`
            : `${c.path} was changed on ${oursName} and deleted on ${theirsName}.`}
        </p>
      );
      choices = oursGone ? (
        <>
          {radio(c.id, 'ours', nr, 'Keep it deleted')}
          {radio(c.id, 'theirs', nr, `Keep the changed file from ${theirsName}`)}
        </>
      ) : (
        <>
          {radio(c.id, 'ours', nr, `Keep the changed file on ${oursName}`)}
          {radio(c.id, 'theirs', nr, 'Delete it')}
        </>
      );
    } else if (c.kind === 'renamed') {
      body = (
        <>
          <p>
            The file is called {file('oursFile')} on {oursName} and {file('theirsFile')} on{' '}
            {theirsName}.
          </p>
          {loses(f, c) && (
            <Notice kind="warning" live="off" className="merge-lose">
              This file was renamed differently on both sides and edited on both. The merge keeps
              one name and one side’s edits. The edits of the other side are not carried: they stay
              in revision {plan!.target.number}, the paper as it is before the merge, which is kept.
            </Notice>
          )}
        </>
      );
      choices = (
        <>
          {radio(c.id, 'ours', nr, `Keep the name ${file('oursFile')}`)}
          {radio(c.id, 'theirs', nr, `Use the name ${file('theirsFile')}`)}
        </>
      );
    } else {
      body = (
        <p>
          {c.path} is a new file on {theirsName}, and {oursName} has another file with that name.
        </p>
      );
      choices = (
        <>
          {radio(c.id, 'ours', nr, `Keep the file on ${oursName}, and leave this one out`)}
          {radio(c.id, 'theirs', nr, `Use this file, and remove the other from ${oursName}`)}
        </>
      );
    }
    return (
      <fieldset key={c.id} className="merge-conflict" id={`conflict-${n}`}>
        <legend>
          Conflict {n} of {total}: {where}
        </legend>
        {body}
        <div className="merge-choices">{choices}</div>
      </fieldset>
    );
  };

  const settingCard = (s: (typeof settingConflicts)[number]) => {
    n += 1;
    const nr = `c${n}`;
    const what = s.key === 'root' ? 'root file' : 'compiler';
    const key = `settings.${s.key}`;
    return (
      <fieldset key={key} className="merge-conflict" id={`conflict-${n}`}>
        <legend>
          Conflict {n} of {total}: the {what}
        </legend>
        <p>
          The {what} was changed on both sides: {oursName} has {s.ours ?? 'none'}, and {theirsName}{' '}
          has {s.theirs ?? 'none'}.
        </p>
        <div className="merge-choices">
          {radio(key, 'ours', nr, `Keep ${s.ours ?? 'none'}`)}
          {radio(key, 'theirs', nr, `Use ${s.theirs ?? 'none'}`)}
        </div>
      </fieldset>
    );
  };

  const lostEdits =
    plan?.files.filter((f) => f.conflicts.some((c) => loses(f, c))).map((f) => f.path) ?? [];

  return (
    <main data-ui="next" className="page merge">
      <KitProvider>
        <OverlayRoot>
          <AppBar
            home="/projects"
            crumbs={[
              { id: 'paper', label: project.name, href: `/projects/${id}` },
              { id: 'merge', label: title, heading: true },
            ]}
          >
            <Link
              prefetch={false}
              href={`/projects/${id}/history#versions`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              All versions
            </Link>
          </AppBar>
          <div className="merge-body">
            {said.length > 0 && <div className="merge-said">{said}</div>}
            {!writer ? (
              <Notice kind="info" live="off">
                Only the owner and the editors of a paper can merge its versions. You can read both
                the paper and the version, and compare them on the{' '}
                <Link prefetch={false} href={`/projects/${version}/history`}>
                  history page
                </Link>
                .
              </Notice>
            ) : !plan ? (
              <Notice kind="error" live="off">
                {refused || 'This merge cannot be made.'}
              </Notice>
            ) : (
              <form action={mergeAction.bind(null, id, version, up)} className="merge-form">
                <input type="hidden" name="target" value={plan.target.revision} />
                <input type="hidden" name="source" value={plan.source.revision} />
                <input type="hidden" name="base" value={plan.base.revision} />
                <section aria-labelledby="merge-summary">
                  <h2 id="merge-summary">What the merge does</h2>
                  <p>
                    {up
                      ? `The version “${found.name}” takes in what main changed since it was started or last merged.`
                      : `Main takes in what the version “${found.name}” changed since it was started or last merged.`}{' '}
                    This is {theirsName} as revision {plan.source.number} into {oursName} as
                    revision {plan.target.number}, which both began from revision {plan.base.number}
                    .{' '}
                    <Link prefetch={false} href={other.href}>
                      {other.label}
                    </Link>
                    .
                  </p>
                  <p>
                    {nothing
                      ? 'There is nothing to merge: nothing changed on the other side that this one does not have.'
                      : `${plural(plan.counts.merged + plan.counts.taken + plan.counts.added + plan.counts.removed, 'file')} merge by themselves, and ${needs === 0 && settingConflicts.length === 0 ? 'none needs you' : `${plural(total, 'decision')} to make`}.`}
                  </p>
                  {lostEdits.length > 0 && (
                    <Notice kind="warning" live="off">
                      {lostEdits.join(', ')} {lostEdits.length === 1 ? 'was' : 'were'} renamed
                      differently on both sides and edited on both. Only one side’s edits can be
                      carried; the other side’s stay in revision {plan.target.number}, the paper as
                      it is before the merge.
                    </Notice>
                  )}
                </section>

                {listed.length > 0 && (
                  <section aria-labelledby="merge-files">
                    <h2 id="merge-files">Files</h2>
                    <ul className="merge-files">
                      {listed.map((f) => (
                        <li key={f.key}>
                          <span className="merge-path">{f.path}</span>
                          <span>{fileLine(f, oursName, theirsName)}</span>
                        </li>
                      ))}
                    </ul>
                    {plan.counts.unchanged > 0 && (
                      <p className="merge-note">
                        {plural(plan.counts.unchanged, 'file')} the same on both sides.
                      </p>
                    )}
                  </section>
                )}
                {settings.some((s) => s.status === 'taken') && (
                  <p className="merge-note">
                    {settings
                      .filter((s) => s.status === 'taken')
                      .map(
                        (s) =>
                          `The ${s.key === 'root' ? 'root file' : 'compiler'} is taken from ${theirsName}.`,
                      )
                      .join(' ')}
                  </p>
                )}

                {total > 0 && (
                  <section aria-labelledby="merge-conflicts">
                    <h2 id="merge-conflicts">Conflicts: {plural(total, 'decision')} to make</h2>
                    <p>
                      Choose one for each. Each is a group of buttons: move between them with the
                      arrow keys.
                    </p>
                    {plan.files
                      .filter((f) => f.status === 'conflict')
                      .flatMap((f) => f.conflicts.map((c) => card(f, c)))}
                    {settingConflicts.map(settingCard)}
                  </section>
                )}

                {!nothing && open && (open.threads > 0 || open.proposals > 0) && (
                  <section aria-labelledby="merge-review">
                    <h2 id="merge-review">Comments and proposals</h2>
                    <p>
                      {theirsName} has {plural(open.threads, 'open comment thread')} and{' '}
                      {plural(open.proposals, 'open proposal')} that {oursName} does not. They stay
                      where they are unless you bring them across. Each is placed on the same words,
                      with the same author; one whose words are not in the merged text stays behind,
                      and you are told. Resolved and decided ones are never moved.
                    </p>
                    <label className="merge-choice" htmlFor="merge-carry">
                      <input type="checkbox" id="merge-carry" name="carry" />
                      <span>Bring open comments and proposals across</span>
                    </label>
                  </section>
                )}

                {!nothing && (
                  <div className="merge-go">
                    <p>
                      The paper as it is now is kept as a revision first, so the merge can be undone
                      by restoring it. Everyone who has {up ? 'the version' : 'the paper'} open is
                      told.
                    </p>
                    <Once>{action}</Once>
                  </div>
                )}
              </form>
            )}
          </div>
        </OverlayRoot>
      </KitProvider>
    </main>
  );
}

export default function Scoped(props: Parameters<typeof Merge>[0]) {
  return withScope(() => Merge(props));
}
