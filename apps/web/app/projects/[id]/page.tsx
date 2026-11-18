import {
  AppError,
  can,
  citationChecks,
  citationReport,
  getProject,
  importReport,
  labelReport,
  listCharts,
  listDatasets,
  listFiles,
  listMembers,
  listProposals,
  listRevisions,
  listThreads,
} from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../lib/server';
import {
  buildRevisionAction,
  deleteFileAction,
  lookUpDoiAction,
  recordEvidenceAction,
  removeEvidenceAction,
  inviteAction,
  removeAction,
  renameAction,
  restoreAction,
  roleAction,
  rootAction,
  saveRevisionAction,
} from '../actions';

export const dynamic = 'force-dynamic';
const INVITABLE = ['editor', 'reviewer', 'viewer'] as const;
const TEX = /\.(tex|ltx)$/i;

export default async function Project({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    invited?: string;
    saved?: string;
    revision?: string;
    restored?: string;
    building?: string;
    added?: string;
    deleted?: string;
    in?: string;
    root?: string;
    relabelled?: string;
    moved?: string;
    looked?: string;
    described?: string;
    checked?: string;
    places?: string;
  }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/projects/${id}`);
  const loaded = await Promise.all([
    getProject(db(), user.id, id),
    listMembers(db(), user.id, id),
    listFiles(db(), user.id, id),
    importReport(db(), user.id, id),
    listRevisions(db(), user.id, id),
    labelReport(db(), blobs(), user.id, id),
    citationReport(db(), blobs(), user.id, id),
    citationChecks(db(), blobs(), user.id, id),
    listDatasets(db(), blobs(), user.id, id),
    listCharts(db(), blobs(), user.id, id),
    listThreads(db(), blobs(), user.id, id),
    listProposals(db(), blobs(), user.id, id),
  ]).catch((err) => {
    // Not a member, or no such paper: the two look the same from outside.
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  const [
    project,
    members,
    files,
    report,
    revisions,
    labels,
    cited,
    checks,
    datasets,
    charts,
    threads,
    proposals,
  ] = loaded;
  const openThreads = threads.filter((t) => t.status === 'open');
  const openProposals = proposals.filter((p) => p.status === 'open');
  const dataFiles = files.filter((f) => /\.(csv|tsv)$/i.test(f.path) && !f.readonly);
  const reviewer = can(project.role, 'comment.write');
  const day = (iso: string) => iso.slice(0, 10);
  const brief = (text: string) => (text.length > 80 ? `${text.slice(0, 80)}…` : text);
  const writer = can(project.role, 'revision.write');
  const about = new Map(report?.files.map((f) => [f.path, f]));
  /** What the visual editor can do with a file, in a few words. */
  const note = (path: string, readonly: string | null) => {
    const f = about.get(path);
    if (readonly === 'binary') return '';
    if (readonly === 'not-utf8') return 'Not UTF-8: kept as it is, cannot be edited here';
    if (readonly === 'mixed-newlines')
      return 'Mixed line endings: kept as it is, cannot be edited here';
    if (f?.sourceOnly) return 'Definitions: edited in source only';
    if (f?.visual) {
      const all = f.visual.editable + f.visual.raw;
      return all ? `${Math.round((100 * f.visual.editable) / all)}% editable visually` : '';
    }
    return '';
  };
  const query = await searchParams;
  const { error, invited, saved, revision, restored, building, added, deleted, root } = query;
  const canWrite = can(project.role, 'file.write');
  const owner = project.role === 'owner';
  return (
    <main className="page">
      <header className="bar">
        <h1>{project.name}</h1>
        <span>
          You are{' '}
          {project.role === 'viewer' || project.role === 'reviewer'
            ? 'a'
            : project.role === 'owner'
              ? 'the'
              : 'an'}{' '}
          {project.role}
        </span>
        <Link href="/projects">All papers</Link>
      </header>
      {error && <p role="alert">{error}</p>}
      {invited && <p role="status">Invitation sent to {invited}.</p>}
      {saved && <p role="status">Role changed.</p>}
      {revision && <p role="status">Saved as revision {revision}.</p>}
      {restored && <p role="status">Restored. The paper is now revision {restored}.</p>}
      {building && <p role="status">Building the PDF for that revision. Reload in a moment.</p>}
      {added && (
        <p role="status">
          Added <code>{added}</code>.
        </p>
      )}
      {deleted && (
        <p role="status">
          Deleted <code>{deleted}</code>. Revision {query.in} still has it: restore that revision to
          bring it back.
        </p>
      )}
      {root && <p role="status">Root file changed.</p>}
      {query.described && <p role="status">Description approved.</p>}
      {query.looked && (
        <p role="status">
          Looked up <code>{query.looked}</code>. The result is beside it below.
        </p>
      )}
      {query.checked && (
        <p role="status">
          Recorded an evidence check for <code>{query.checked}</code>.
        </p>
      )}
      {query.moved && (
        <p role="status">
          Renamed to <code>{query.moved}</code>
          {query.places && query.places !== '0'
            ? `, and updated ${query.places} ${query.places === '1' ? 'place that names' : 'places that name'} it.`
            : '.'}
        </p>
      )}
      {query.relabelled && (
        <p role="status">
          Renamed to <code>{query.relabelled}</code> in {query.places}{' '}
          {query.places === '1' ? 'place' : 'places'}.
        </p>
      )}

      <h2>Files</h2>
      {files.length > 0 && (
        <>
          <p>
            Root file: <code>{project.root ?? 'none'}</code>. Compiler:{' '}
            <code>{project.compiler}</code>.{' '}
            {can(project.role, 'project.export') && (
              <a href={`/projects/${id}/export`}>Download ZIP</a>
            )}{' '}
            <Link href={`/projects/${id}/submit`}>Check before submitting</Link>
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Size</th>
                <th scope="col">In the visual editor</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <th scope="row">
                    {f.readonly ? (
                      <code>{f.path}</code>
                    ) : (
                      <Link href={`/projects/${id}/files/${f.id}`}>
                        <code>{f.path}</code>
                      </Link>
                    )}
                  </th>
                  <td>{f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</td>
                  <td>{note(f.path, f.readonly)}</td>
                  <td>
                    {f.path === project.root && 'Root file '}
                    {canWrite && f.path !== project.root && !f.readonly && TEX.test(f.path) && (
                      <form action={rootAction.bind(null, id, f.id)} className="inline">
                        <button type="submit" aria-label={`Make ${f.path} the root file`}>
                          Make root
                        </button>
                      </form>
                    )}{' '}
                    {canWrite && f.path !== project.root && (
                      <form action={deleteFileAction.bind(null, id, f.id)} className="inline">
                        <button type="submit" aria-label={`Delete ${f.path}`}>
                          Delete
                        </button>
                      </form>
                    )}
                    {canWrite && (
                      <details>
                        <summary>Rename</summary>
                        <form action={renameAction.bind(null, id, f.id)} className="inline">
                          <input
                            name="path"
                            defaultValue={f.path}
                            aria-label={`New name for ${f.path}`}
                            required
                          />
                          <button type="submit">Rename</button>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {canWrite && (
        <form method="post" action={`/projects/${id}/files`} encType="multipart/form-data">
          <h3>Add a file</h3>
          <label>
            Name, with folders if you like
            <input name="path" maxLength={255} placeholder="sections/methods.tex" />
          </label>
          <label>
            A file to upload. Leave empty to start a blank text file.
            <input type="file" name="file" />
          </label>
          <button type="submit">Add file</button>
        </form>
      )}
      {report && (
        <>
          <h2>Import report</h2>
          <ul className="report">
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {report.otherRoots.length > 0 && (
              <li>
                Other files that could be the root: <code>{report.otherRoots.join(', ')}</code>
              </li>
            )}
            {report.missing.map((m) => (
              <li key={m.from + m.target}>
                <code>{m.from}</code> refers to <code>{m.target}</code>, which is not in the
                project.
              </li>
            ))}
            {report.dynamic.map((m) => (
              <li key={m.from + m.target}>
                <code>{m.from}</code> includes <code>{m.target}</code>, a path only LaTeX can work
                out.
              </li>
            ))}
            {report.cycles.map((c) => (
              <li key={c.join()}>
                These files include each other in a loop: <code>{c.join(' → ')}</code>
              </li>
            ))}
            {report.skipped.map((k) => (
              <li key={k.path}>
                Left out: <code>{k.path}</code> ({k.reason}).
              </li>
            ))}
          </ul>
        </>
      )}

      {(labels.labels.length > 0 || labels.undefined.length > 0) && (
        <>
          <h2 id="labels">Labels and references</h2>
          <p>
            {labels.labels.length} {labels.labels.length === 1 ? 'label' : 'labels'}.{' '}
            {labels.undefined.length + labels.duplicates.length === 0
              ? 'Every reference points to one of them.'
              : 'Some need attention:'}
          </p>
          {labels.undefined.length + labels.duplicates.length > 0 && (
            <ul className="report">
              {labels.undefined.map((r) => (
                <li key={`${r.fileId}:${r.line}:${r.key}`}>
                  <Link href={`/projects/${id}/files/${r.fileId}`}>
                    <code>
                      {r.path}:{r.line}
                    </code>
                  </Link>{' '}
                  refers to <code>{r.key}</code>, and no label has that name. The PDF shows ??
                  there.
                </li>
              ))}
              {labels.duplicates.map((d) => (
                <li key={d.key}>
                  <code>{d.key}</code> names {d.places.length} labels:{' '}
                  {d.places.map((p, i) => (
                    <span key={`${p.fileId}:${p.line}`}>
                      {i > 0 && ', '}
                      <Link href={`/projects/${id}/files/${p.fileId}`}>
                        <code>
                          {p.path}:{p.line}
                        </code>
                      </Link>
                    </span>
                  ))}
                  . References to it go to the last one.
                </li>
              ))}
            </ul>
          )}
          {canWrite && labels.labels.length > 0 && (
            <form action={`/projects/${id}/labels/rename`} className="inline">
              <label>
                Rename the label{' '}
                <select name="from">
                  {[...new Set(labels.labels.map((l) => l.key))].sort().map((key) => (
                    <option key={key}>{key}</option>
                  ))}
                </select>
              </label>{' '}
              <label>
                to <input name="to" required maxLength={200} />
              </label>{' '}
              <button type="submit">See what would change</button>
            </form>
          )}
        </>
      )}

      {(cited.entries.length > 0 || cited.missing.length > 0) && (
        <>
          <h2 id="bibliography">Bibliography</h2>
          <p>
            {cited.entries.length} {cited.entries.length === 1 ? 'entry' : 'entries'}.{' '}
            {cited.missing.length + cited.duplicates.length === 0
              ? 'Every citation has one.'
              : 'Some need attention:'}
          </p>
          {cited.missing.length + cited.duplicates.length > 0 && (
            <ul className="report">
              {cited.missing.map((m) => (
                <li key={`${m.fileId}:${m.line}:${m.key}`}>
                  <Link href={`/projects/${id}/files/${m.fileId}`}>
                    <code>
                      {m.path}:{m.line}
                    </code>
                  </Link>{' '}
                  cites <code>{m.key}</code>, and no entry has that key. The PDF shows a question
                  mark there.
                </li>
              ))}
              {cited.duplicates.map((d) => (
                <li key={d.key}>
                  <code>{d.key}</code> is the key of {d.places.length} entries:{' '}
                  {d.places.map((p, i) => (
                    <span key={`${p.fileId}:${p.line}`}>
                      {i > 0 && ', '}
                      <Link href={`/projects/${id}/files/${p.fileId}`}>
                        <code>
                          {p.path}:{p.line}
                        </code>
                      </Link>
                    </span>
                  ))}
                  . Only one of them is used.
                </li>
              ))}
            </ul>
          )}
          {cited.entries.length > 0 && (
            <>
              <p>
                Two different things can be checked about a citation, and they are recorded apart.
                Whether the <strong>entry is right</strong> is checked by looking its DOI up.
                Whether the source <strong>supports what the paper says</strong> is a person&apos;s
                judgement about one claim. One says nothing about the other.
              </p>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Entry</th>
                    <th scope="col">Is the entry right?</th>
                    <th scope="col">Does it support the claim?</th>
                  </tr>
                </thead>
                <tbody>
                  {cited.entries
                    .filter((e, i) => cited.entries.findIndex((x) => x.key === e.key) === i)
                    .map((e) => {
                      const looked = checks.lookups[e.key];
                      const evidence = checks.evidence[e.key] ?? [];
                      const differing = looked?.comparison.filter((c) => !c.same) ?? [];
                      return (
                        <tr key={e.key}>
                          <th scope="row">
                            <code>{e.key}</code>
                            <br />
                            <span className="role">{e.description}</span>
                          </th>
                          <td>
                            {!e.doi && !looked && 'No DOI to look up.'}
                            {e.doi && !looked && 'Not looked up.'}
                            {looked && (
                              <>
                                {looked.outcome === 'matches' && 'Matches the registry.'}
                                {looked.outcome === 'not_found' &&
                                  'The registry has no record of this DOI.'}
                                {looked.outcome === 'differs' && (
                                  <>
                                    Differs from the registry:
                                    <ul>
                                      {differing.map((c) => (
                                        <li key={c.field}>
                                          {c.field}: the entry says “{c.entry || 'nothing'}”, the
                                          registry “{c.registry || 'nothing'}”
                                        </li>
                                      ))}
                                    </ul>
                                  </>
                                )}{' '}
                                <span className="role">
                                  Looked up in{' '}
                                  {looked.source === 'crossref' ? 'Crossref' : looked.source} on{' '}
                                  {day(looked.lookedUpAt)}
                                  {looked.lookedUpBy ? ` by ${looked.lookedUpBy}` : ''}.
                                </span>
                                {looked.outOfDate && (
                                  <>
                                    {' '}
                                    <strong>The entry has been changed since.</strong>
                                  </>
                                )}
                              </>
                            )}
                            {reviewer && e.doi && (
                              <form
                                action={lookUpDoiAction.bind(null, id, e.key)}
                                className="inline"
                              >
                                {' '}
                                <button type="submit" aria-label={`Look up the DOI of ${e.key}`}>
                                  {looked ? 'Look up again' : 'Look up DOI'}
                                </button>
                              </form>
                            )}
                          </td>
                          <td>
                            {evidence.length === 0 && 'No claim checked.'}
                            <ul>
                              {evidence.map((c) => (
                                <li key={c.id}>
                                  <strong>
                                    {c.verdict === 'supports'
                                      ? 'Supports'
                                      : c.verdict === 'partly'
                                        ? 'Partly supports'
                                        : 'Does not support'}
                                  </strong>
                                  : “{c.claim}”{c.note ? ` (${c.note})` : ''}{' '}
                                  <span className="role">
                                    {c.checkedBy ?? 'Someone'}, {day(c.checkedAt)}.
                                  </span>
                                  {!c.stillSaid && (
                                    <>
                                      {' '}
                                      <strong>The paper no longer says this.</strong>
                                    </>
                                  )}
                                  {c.mine && (
                                    <form
                                      action={removeEvidenceAction.bind(null, id, c.id)}
                                      className="inline"
                                    >
                                      {' '}
                                      <button
                                        type="submit"
                                        aria-label={`Remove this check of ${e.key}`}
                                      >
                                        Remove
                                      </button>
                                    </form>
                                  )}
                                </li>
                              ))}
                            </ul>
                            {reviewer && (
                              <details>
                                <summary>Record a check</summary>
                                <form action={recordEvidenceAction.bind(null, id, e.key)}>
                                  <label>
                                    The claim, quoted from the paper
                                    <textarea
                                      name="claim"
                                      required
                                      maxLength={2000}
                                      rows={2}
                                      aria-label={`The claim that cites ${e.key}`}
                                    />
                                  </label>
                                  <label>
                                    The source
                                    <select name="verdict" defaultValue="supports">
                                      <option value="supports">supports it</option>
                                      <option value="partly">partly supports it</option>
                                      <option value="does_not_support">does not support it</option>
                                    </select>
                                  </label>
                                  <label>
                                    Note, such as where in the source
                                    <input name="note" maxLength={2000} />
                                  </label>
                                  <button type="submit">Record</button>
                                </form>
                              </details>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {dataFiles.length > 0 && (
        <>
          <h2 id="data">Data</h2>
          <p>
            A CSV file becomes data once someone has said what its columns hold. Charts are drawn
            only from a file as it was when its description was approved.
          </p>
          <ul className="report">
            {dataFiles.map((f) => {
              const d = datasets.find((x) => x.fileId === f.id);
              return (
                <li key={f.id}>
                  <code>{f.path}</code>:{' '}
                  {!d ? (
                    'not described yet. '
                  ) : (
                    <>
                      {d.columns
                        .map((c) => `${c.name}${c.unit ? ` in ${c.unit}` : ''} (${c.type})`)
                        .join(', ')}
                      . Approved {d.approvedAt.slice(0, 10)}
                      {d.approvedBy ? ` by ${d.approvedBy}` : ''}.{' '}
                      {d.exported ? 'Included in downloads. ' : 'Not included in downloads. '}
                      {d.changed && (
                        <strong>The file has changed since: its charts are out of date. </strong>
                      )}
                    </>
                  )}
                  <Link href={`/projects/${id}/data/${f.id}`}>
                    {d
                      ? d.changed
                        ? 'Look at it again'
                        : 'See or change its description'
                      : 'Describe it'}
                  </Link>
                  {d && !d.changed && canWrite && (
                    <>
                      {' '}
                      <Link href={`/projects/${id}/charts/new?data=${f.id}`}>
                        New chart from {f.path}
                      </Link>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {charts.length > 0 && (
            <>
              <h3>Charts</h3>
              <ul className="report">
                {charts.map((c) => (
                  <li key={c.id}>
                    <Link href={`/projects/${id}/charts/${c.id}`}>{c.name}</Link>: {c.alt}{' '}
                    {c.status === 'queued' && 'Waiting to be drawn.'}
                    {c.status === 'failed' && <strong>Could not be drawn.</strong>}
                    {c.status === 'drawn' &&
                      (c.stale ? (
                        <strong>Out of date: its data has changed since it was drawn.</strong>
                      ) : (
                        `Drawn ${c.drawnAt!.slice(0, 10)}.`
                      ))}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {threads.length + proposals.length > 0 && (
        <>
          <h2 id="review">Review</h2>
          {openThreads.length + openProposals.length === 0 && (
            <p>Every thread is resolved and every proposed change is decided.</p>
          )}
          <ul className="report">
            {openProposals.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${id}/files/${p.fileId}#proposals`}>{p.path}</Link>:{' '}
                {p.author ?? 'someone who has left'} proposes{' '}
                {p.expected ? (
                  <>
                    changing <q>{brief(p.expected)}</q> to <q>{brief(p.replacement)}</q>
                  </>
                ) : (
                  <>
                    adding <q>{brief(p.replacement)}</q>
                  </>
                )}
                .{p.stale && <strong> Out of date: the text has changed since.</strong>}
              </li>
            ))}
            {openThreads.map((t) => (
              <li key={t.id}>
                <Link href={`/projects/${id}/files/${t.fileId}#comments`}>{t.path}</Link>:{' '}
                <q>{brief(t.excerpt)}</q>
                {t.state === 'detached' && <strong> (this text has been deleted)</strong>}.{' '}
                {t.comments.length} {t.comments.length === 1 ? 'comment' : 'comments'}, the latest
                by {t.comments.at(-1)?.author ?? 'someone who has left'}.
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 id="revisions">Revisions</h2>
      <p>
        A revision is the whole paper at one moment. Its ZIP and its PDF always belong together.
      </p>
      {writer && (
        <form action={saveRevisionAction.bind(null, id)}>
          <label>
            Name for the paper as it is now
            <input name="name" required maxLength={200} placeholder="Submitted to the workshop" />
          </label>
          <button type="submit">Save revision</button>
        </form>
      )}
      {revisions.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Revision</th>
              <th scope="col">Made</th>
              <th scope="col">Download</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((r, i) => (
              <tr key={r.id}>
                <th scope="row">
                  {r.number}.{' '}
                  {r.name ??
                    (r.kind === 'restore' ? `Restore of revision ${r.restoredFrom}` : 'Unnamed')}
                </th>
                <td>
                  {new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
                  {r.createdBy ? ` by ${r.createdBy}` : ''}
                </td>
                <td>
                  {can(project.role, 'project.export') && (
                    <>
                      <a href={`/projects/${id}/revisions/${r.id}/zip`}>ZIP</a>{' '}
                      <a href={`/projects/${id}/revisions/${r.id}/zip?manifest`}>
                        ZIP with build details
                      </a>{' '}
                    </>
                  )}
                  {r.hasPdf ? (
                    <a href={`/projects/${id}/revisions/${r.id}/pdf`}>PDF</a>
                  ) : (
                    can(project.role, 'build.run') && (
                      <form action={buildRevisionAction.bind(null, id, r.id)} className="inline">
                        <button type="submit" aria-label={`Build the PDF for revision ${r.number}`}>
                          Build PDF
                        </button>
                      </form>
                    )
                  )}
                </td>
                <td>
                  {revisions[i + 1] && (
                    <Link href={`/projects/${id}/revisions/${r.id}/diff/${revisions[i + 1].id}`}>
                      Changes since {revisions[i + 1].number}
                    </Link>
                  )}{' '}
                  {writer && (
                    <form action={restoreAction.bind(null, id, r.id)} className="inline">
                      <button type="submit" aria-label={`Restore revision ${r.number}`}>
                        Restore
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>People</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <th scope="row">{m.email}</th>
              <td>
                {owner && m.role !== 'owner' ? (
                  <form action={roleAction.bind(null, id, m.userId)} className="inline">
                    <select name="role" defaultValue={m.role} aria-label={`Role of ${m.email}`}>
                      {INVITABLE.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                    <button type="submit">Change</button>
                  </form>
                ) : (
                  m.role
                )}
              </td>
              <td>
                {m.role !== 'owner' && (owner || m.userId === user.id) && (
                  <form action={removeAction.bind(null, id, m.userId)} className="inline">
                    <button
                      type="submit"
                      aria-label={m.userId === user.id ? 'Leave this paper' : `Remove ${m.email}`}
                    >
                      {m.userId === user.id ? 'Leave' : 'Remove'}
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {owner && (
        <>
          <h2>Invite someone</h2>
          <form action={inviteAction.bind(null, id)}>
            <label>
              Their email address
              <input type="email" name="email" required />
            </label>
            <label>
              Their role
              <select name="role" defaultValue="editor">
                {INVITABLE.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <button type="submit">Send invitation</button>
          </form>
        </>
      )}
    </main>
  );
}
