import {
  AppError,
  can,
  getProject,
  importReport,
  listFiles,
  listMembers,
  listRevisions,
} from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, requireUser } from '../../../lib/server';
import {
  buildRevisionAction,
  inviteAction,
  removeAction,
  renameAction,
  restoreAction,
  roleAction,
  saveRevisionAction,
} from '../actions';

export const dynamic = 'force-dynamic';
const INVITABLE = ['editor', 'reviewer', 'viewer'] as const;

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
  ]).catch((err) => {
    // Not a member, or no such paper: the two look the same from outside.
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  const [project, members, files, report, revisions] = loaded;
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
  const { error, invited, saved, revision, restored, building } = await searchParams;
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

      {files.length > 0 && (
        <>
          <h2>Files</h2>
          <p>
            Root file: <code>{project.root ?? 'none'}</code>. Compiler:{' '}
            <code>{project.compiler}</code>.{' '}
            {can(project.role, 'project.export') && (
              <a href={`/projects/${id}/export`}>Download ZIP</a>
            )}
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
                    {can(project.role, 'file.write') && (
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
                  {writer && i > 0 && (
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
