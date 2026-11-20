import DirectUpload from '../../DirectUpload';
import Once from '../../Once';
import { Wide } from '../../Wide';
import {
  AppError,
  withScope,
  can,
  citationChecks,
  citationReport,
  firstSteps,
  getProject,
  importReport,
  labelReport,
  languageSettings,
  listCharts,
  heldDataReadBy,
  heldInRevisions,
  heldLine,
  heldNow,
  heldReadMessage,
  listDatasets,
  listFiles,
  listInvitations,
  listMembers,
  listProposals,
  listRevisions,
  olderAutoRevisions,
  REVISIONS_SHOWN,
  listThreads,
  modelProcessing,
} from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../lib/server';
import {
  buildRevisionAction,
  cancelInvitationAction,
  deleteFileAction,
  lookUpDoiAction,
  recordEvidenceAction,
  removeEvidenceAction,
  inviteAction,
  languageAction,
  modelProcessingAction,
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

async function Project({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    invited?: string;
    cancelled?: string;
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
    before?: string;
    entries?: string;
    looked?: string;
    described?: string;
    language?: string;
    assistance?: string;
    checked?: string;
    places?: string;
  }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/projects/${id}`);
  // "Older revisions" asks for those below a number.
  const asked = Number((await searchParams).before);
  const olderThan = Number.isInteger(asked) && asked > 0 ? asked : undefined;
  const loaded = await Promise.all([
    getProject(db(), user.id, id),
    listMembers(db(), user.id, id),
    listFiles(db(), user.id, id),
    importReport(db(), user.id, id),
    listRevisions(db(), user.id, id, { autos: REVISIONS_SHOWN, before: olderThan }),
    labelReport(db(), blobs(), user.id, id),
    citationReport(db(), blobs(), user.id, id),
    citationChecks(db(), blobs(), user.id, id),
    listDatasets(db(), blobs(), user.id, id),
    listCharts(db(), blobs(), user.id, id),
    listThreads(db(), blobs(), user.id, id),
    listProposals(db(), blobs(), user.id, id),
    languageSettings(db(), user.id, id),
    modelProcessing(db(), user.id, id),
    firstSteps(db(), user.id, id),
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
    language,
    allowModel,
    steps,
  ] = loaded;
  // The oldest automatic revision shown, and how many there are before it.
  const heldAway = await heldNow(db(), user.id, id);
  const heldReads = new Set((await heldDataReadBy(db(), blobs(), user.id, id)).map((h) => h.path));
  const heldBy = await heldInRevisions(
    db(),
    user.id,
    id,
    revisions.map((r) => r.id),
  );
  const oldestAuto = revisions.findLast((r) => r.kind === 'auto')?.number;
  const olderAutos = oldestAuto ? await olderAutoRevisions(db(), user.id, id, oldestAuto) : 0;
  const pending = project.role === 'owner' ? await listInvitations(db(), user.id, id) : [];
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
  // The bibliography's table is of what the paper cites, and of anything a check has been
  // recorded for. A .bib file kept for many papers holds thousands of entries this paper
  // never names; each row here has forms, and 2,000 of them made a page of 6 MB.
  const allEntries = query.entries === 'all';
  const entryKeys = new Set<string>();
  const oneOfEach = cited.entries.filter((e) => !entryKeys.has(e.key) && entryKeys.add(e.key));
  const listedEntries = oneOfEach.filter(
    (e) => allEntries || e.cited || checks.lookups[e.key] || checks.evidence[e.key]?.length,
  );
  const unlisted = oneOfEach.length - listedEntries.length;
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
        <Link prefetch={false} href="/projects">
          All papers
        </Link>
      </header>
      {error && <p role="alert">{error}</p>}
      {invited && <p role="status">Invitation sent to {invited}.</p>}
      {query.cancelled && <p role="status">Invitation to {query.cancelled} cancelled.</p>}
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

      {owner && !(steps.written && steps.built && steps.shared && steps.downloaded) && (
        <section aria-labelledby="first-steps">
          <h2 id="first-steps">First steps</h2>
          <p>What a new paper usually needs, and how far this one has come.</p>
          <ol className="report first-steps">
            {(
              [
                [
                  steps.hasFiles,
                  'Give it something to hold',
                  'Add a file below, or start again from a template or a ZIP on the list of papers.',
                ],
                [
                  steps.written,
                  'Write in it',
                  'Open a .tex file under Files. It opens as the paper reads; "Source" shows the LaTeX.',
                ],
                [
                  steps.built,
                  'See the PDF',
                  'It is built beside the text when a file is open, and again whenever you stop typing.',
                ],
                [
                  steps.shared,
                  'Bring in a co-author',
                  'Under People, invite someone as an editor to write with you, or as a reviewer to comment and propose changes.',
                ],
                [
                  steps.downloaded,
                  'Take it away',
                  '"Check before submitting" says what is still wrong and gives the ZIP and PDF of one revision.',
                ],
              ] as const
            ).map(([done, what, how]) => (
              <li key={what}>
                <strong>{done ? 'Done' : 'To do'}:</strong> {what}.{!done && ` ${how}`}
              </li>
            ))}
          </ol>
        </section>
      )}
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
            : ', and no line needed changing.'}
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
              <>
                <a href={`/projects/${id}/export`}>Download ZIP</a>{' '}
                <a href={`/projects/${id}/export?review`}>ZIP with review data</a>{' '}
                {heldLine(heldAway) && (
                  <>
                    <br />
                    <small>{heldLine(heldAway)}</small>
                    <br />
                  </>
                )}
                <small>
                  Comments and proposed changes come too; saved revisions, citation checks, data
                  descriptions, chart settings and language settings do not.
                </small>
              </>
            )}{' '}
            <Link prefetch={false} href={`/projects/${id}/submit`}>
              Check before submitting
            </Link>
          </p>
          <Wide label="Table of files">
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
                        <Link prefetch={false} href={`/projects/${id}/files/${f.id}`}>
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
          </Wide>
        </>
      )}
      {canWrite && (
        <DirectUpload action={`/projects/${id}/files`} kind="file" projectId={id} field="file">
          <h3>Add a file</h3>
          <label>
            Name, with folders if you like
            <input name="path" maxLength={255} placeholder="sections/methods.tex" />
          </label>
          <label>
            A file to upload. Leave empty to start a blank text file.
            <input type="file" name="file" />
          </label>
          <Once>Add file</Once>
        </DirectUpload>
      )}
      {report && (
        <>
          <h2>Import report</h2>
          <ul className="report">
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {report.review && (
              <li>
                Review data came with the archive: {report.review.threads}{' '}
                {report.review.threads === 1 ? 'thread' : 'threads'} and {report.review.proposals}{' '}
                proposed {report.review.proposals === 1 ? 'change' : 'changes'} were brought in
                {report.review.detached > 0 &&
                  `, ${report.review.detached} of the threads about text that is no longer in the paper`}
                . See Review below. Files, comments and proposed changes came with the archive.
                Saved revisions, checked citations, data descriptions, chart settings and language
                settings stay with the paper they were made in.
              </li>
            )}
            {report.review?.missing.map((m) => (
              <li key={m}>Not brought in: {m}</li>
            ))}
            {report.otherRoots.length > 0 && (
              <li>
                Other files that could be the root: <code>{report.otherRoots.join(', ')}</code>
              </li>
            )}
            {report.missing.map((m) => (
              <li key={m.from + m.target}>
                <code>{m.from}</code> refers to <code>{m.target}</code>, which is not among the
                paper&apos;s files. It may come with the TeX installation, which only a build can
                tell.
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
                  <Link prefetch={false} href={`/projects/${id}/files/${r.fileId}`}>
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
                      <Link prefetch={false} href={`/projects/${id}/files/${p.fileId}`}>
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
                  <Link prefetch={false} href={`/projects/${id}/files/${m.fileId}`}>
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
                      <Link prefetch={false} href={`/projects/${id}/files/${p.fileId}`}>
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
              {listedEntries.length > 0 && (
                <Wide label="Table of references">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Entry</th>
                        <th scope="col">Is the entry right?</th>
                        <th scope="col">Does it support the claim?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listedEntries.map((e) => {
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
                                    'Crossref has no record of this DOI. It may be wrong, or registered elsewhere: arXiv and Zenodo DOIs, for example, are registered with DataCite.'}
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
                                        <option value="does_not_support">
                                          does not support it
                                        </option>
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
                </Wide>
              )}
              {unlisted > 0 && (
                <p>
                  {unlisted === 1
                    ? 'One more entry is in the paper’s .bib files and is not cited in it.'
                    : `${unlisted} more entries are in the paper’s .bib files and are not cited in it.`}{' '}
                  <Link prefetch={false} href={`/projects/${id}?entries=all#bibliography`}>
                    List them too
                  </Link>
                </p>
              )}
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
                      {!d.exported && heldReads.has(f.path) && (
                        <strong>{heldReadMessage(f.path)} </strong>
                      )}
                      {d.changed && (
                        <strong>The file has changed since: its charts are out of date. </strong>
                      )}
                    </>
                  )}
                  <Link prefetch={false} href={`/projects/${id}/data/${f.id}`}>
                    {d
                      ? d.changed
                        ? 'Look at it again'
                        : 'See or change its description'
                      : 'Describe it'}
                  </Link>
                  {d && !d.changed && canWrite && (
                    <>
                      {' '}
                      <Link prefetch={false} href={`/projects/${id}/charts/new?data=${f.id}`}>
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
                    <Link prefetch={false} href={`/projects/${id}/charts/${c.id}`}>
                      {c.name}
                    </Link>
                    : {c.alt} {c.status === 'queued' && 'Waiting to be drawn.'}
                    {c.status === 'failed' && <strong>Could not be drawn.</strong>}
                    {c.status === 'drawn' &&
                      (c.missing ? (
                        <strong>Its files are no longer in the paper: draw it again.</strong>
                      ) : c.stale ? (
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
                <Link prefetch={false} href={`/projects/${id}/files/${p.fileId}#proposals`}>
                  {p.path}
                </Link>
                : {p.author ?? 'someone who has left'} proposes{' '}
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
                <Link prefetch={false} href={`/projects/${id}/files/${t.fileId}#comments`}>
                  {t.path}
                </Link>
                : <q>{brief(t.excerpt)}</q>
                {t.state === 'detached' && <strong> (this text has been deleted)</strong>}.{' '}
                {t.comments.length} {t.comments.length === 1 ? 'comment' : 'comments'}, the latest
                by {t.comments.at(-1)?.author ?? 'someone who has left'}.
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 id="language">Language</h2>
      {query.language && <p role="status">Language settings saved.</p>}
      <form action={languageAction.bind(null, id)}>
        <label>
          Spelling
          <select name="language" defaultValue={language.language} disabled={!canWrite}>
            <option value="en-GB">British English</option>
            <option value="en-US">American English</option>
          </select>
        </label>
        <label>
          The paper&apos;s own words, which are not spelling mistakes
          <textarea
            name="glossary"
            rows={3}
            defaultValue={language.glossary.join('\n')}
            disabled={!canWrite}
            aria-describedby="glossary-help"
          />
        </label>
        <small id="glossary-help">Names, coinages and abbreviations, one to a line.</small>
        {language.off.length > 0 && (
          <fieldset>
            <legend>Rules switched off for this paper. Untick one to have it checked again.</legend>
            {language.off.map((rule) => (
              <label key={rule}>
                <input
                  type="checkbox"
                  name="off"
                  value={rule}
                  defaultChecked
                  disabled={!canWrite}
                />{' '}
                <code>{rule}</code>
              </label>
            ))}
          </fieldset>
        )}
        {canWrite && <button type="submit">Save language settings</button>}
      </form>

      <h2 id="assistance">Writing assistance</h2>
      {query.assistance && <p role="status">Saved.</p>}
      <p>
        A review by a language model reads the passage it is asked about and proposes changes, which
        are never made unless someone accepts them. For that, the passage is sent to the
        model&apos;s provider. Spelling and grammar checking is separate and sends nothing outside
        this service.
      </p>
      {owner ? (
        <form action={modelProcessingAction.bind(null, id)}>
          <label>
            <input type="checkbox" name="allow" defaultChecked={allowModel} /> Allow passages of
            this paper to be sent to the model provider when someone asks for a review
          </label>
          <button type="submit">Save</button>
        </form>
      ) : (
        <p>
          {allowModel
            ? 'The owner of this paper allows it.'
            : 'The owner of this paper has not allowed it, so nothing is sent.'}
        </p>
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
        <Wide label="Table of revisions">
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
                        {heldLine(heldBy.get(r.id) ?? []) && (
                          <>
                            <br />
                            <small>{heldLine(heldBy.get(r.id) ?? [])}</small>
                            <br />
                          </>
                        )}
                      </>
                    )}
                    {r.hasPdf ? (
                      <a href={`/projects/${id}/revisions/${r.id}/pdf`}>PDF</a>
                    ) : (
                      can(project.role, 'build.run') && (
                        <form action={buildRevisionAction.bind(null, id, r.id)} className="inline">
                          <button
                            type="submit"
                            aria-label={`Build the PDF for revision ${r.number}`}
                          >
                            Build PDF
                          </button>
                        </form>
                      )
                    )}
                  </td>
                  <td>
                    {revisions[i + 1] && (
                      <Link
                        prefetch={false}
                        href={`/projects/${id}/revisions/${r.id}/diff/${revisions[i + 1].id}`}
                      >
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
        </Wide>
      )}
      {(olderAutos > 0 || olderThan) && (
        <p>
          {olderThan
            ? `These are revisions from before revision ${olderThan}. `
            : `Every revision that was named or restored is listed, and the newest ${REVISIONS_SHOWN} made automatically. `}
          {olderAutos > 0 && (
            <Link prefetch={false} href={`/projects/${id}?before=${oldestAuto}#revisions`}>
              {olderAutos === 1
                ? 'One older automatic revision'
                : `${olderAutos} older automatic revisions`}
            </Link>
          )}{' '}
          {olderThan && (
            <Link prefetch={false} href={`/projects/${id}#revisions`}>
              Back to the newest
            </Link>
          )}
        </p>
      )}

      <h2>People</h2>
      <Wide label="Table of people">
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
                      <Once
                        aria-label={m.userId === user.id ? 'Leave this paper' : `Remove ${m.email}`}
                      >
                        {m.userId === user.id ? 'Leave' : 'Remove'}
                      </Once>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Wide>

      {owner && (
        <>
          {pending.length > 0 && (
            <section aria-labelledby="pending-heading">
              <h2 id="pending-heading">Invited, not yet joined</h2>
              <ul>
                {pending.map((i) => (
                  <li key={i.id}>
                    {i.email}, as {i.role === 'editor' ? 'an' : 'a'} {i.role}, until{' '}
                    {day(i.expiresAt)}{' '}
                    <form
                      action={cancelInvitationAction.bind(null, id, i.id, i.email)}
                      className="inline"
                    >
                      <Once>Cancel the invitation to {i.email}</Once>
                    </form>
                  </li>
                ))}
              </ul>
            </section>
          )}
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
            <Once>Send invitation</Once>
          </form>
        </>
      )}
    </main>
  );
}

// What this page reads about the paper, it reads once.
export default function Scoped(props: Parameters<typeof Project>[0]) {
  return withScope(() => Project(props));
}
