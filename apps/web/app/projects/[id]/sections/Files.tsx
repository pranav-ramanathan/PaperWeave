import DirectUpload from '../../../DirectUpload';
import Once from '../../../Once';
import { Wide } from '../../../Wide';
import {
  can,
  COMPILERS,
  heldLine,
  summarizeImport,
  type heldNow,
  type importReport,
  type listFiles,
} from '@paperweave/server';
import Link from '../../../Go';
import Result from '../../../Result';
import type { paperOf } from '../../../../lib/server';
import { compilerAction, deleteFileAction, renameAction, rootAction } from '../../actions';

type Files = Awaited<ReturnType<typeof listFiles>>;
type Report = Awaited<ReturnType<typeof importReport>>;
type Held = Awaited<ReturnType<typeof heldNow>>;
type Project = Awaited<ReturnType<typeof paperOf>>;

const TEX = /\.(tex|ltx)$/i;

/** What a file action reported: added, deleted, root or compiler changed. */
export function FileNotices({
  added,
  replaced,
  deleted,
  revision,
  root,
  compiler,
}: {
  added?: string;
  replaced?: string;
  deleted?: string;
  /** The revision that still has a deleted file (the `in` parameter). */
  revision?: string;
  root?: string;
  compiler?: string;
}) {
  return (
    <>
      {added && (
        <Result>
          {replaced ? 'Replaced' : 'Added'} <code>{added}</code>.
        </Result>
      )}
      {deleted && (
        <Result>
          Deleted <code>{deleted}</code>. Revision {revision} still has it: restore that revision to
          bring it back.
        </Result>
      )}
      {root && <Result>Root file changed.</Result>}
      {compiler && <Result>Compiler changed.</Result>}
    </>
  );
}

/** Shown after a file was renamed. */
export function MovedNotice({ moved, places }: { moved?: string; places?: string }) {
  return (
    <>
      {moved && (
        <Result>
          Renamed to <code>{moved}</code>
          {places && places !== '0'
            ? `, and updated ${places} ${places === '1' ? 'place that names' : 'places that name'} it.`
            : ', and no line needed changing.'}
        </Result>
      )}
    </>
  );
}

/** The paper's files: root and compiler, the table, adding a file, and the import report. */
export function Files({
  id,
  project,
  files,
  report,
  heldAway,
}: {
  id: string;
  project: Project;
  files: Files;
  report: Report;
  heldAway: Held;
}) {
  const canWrite = can(project.role, 'file.write');
  const about = new Map(report?.files.map((f) => [f.path, f]));
  /** What the visual editor can do with a file, in a few words. */
  const note = (path: string, readonly: string | null) => {
    const f = about.get(path);
    if (readonly === 'binary') return '';
    if (readonly === 'not-utf8') return 'Not UTF-8 text: kept as it is, cannot be edited here';
    if (readonly === 'mixed-newlines')
      return 'Mixed line endings: upload the file again to edit it here';
    if (f?.sourceOnly) return 'Definitions: edited in source only';
    if (f?.visual) {
      const all = f.visual.editable + f.visual.raw;
      return all ? `${Math.round((100 * f.visual.editable) / all)}% editable visually` : '';
    }
    return '';
  };
  return (
    <>
      <h2 id="files" tabIndex={-1}>
        Files
      </h2>
      {files.length > 0 && (
        <>
          <p className="files-meta">
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
                  {heldAway.length > 0 &&
                    ' Comments and proposed changes on the files kept back are left out too.'}
                </small>
              </>
            )}{' '}
            <Link prefetch={false} href={`/projects/${id}/submit`}>
              Check before submitting
            </Link>
          </p>
          {canWrite && (
            <form action={compilerAction.bind(null, id)} className="inline">
              <label>
                Change compiler{' '}
                <select name="compiler" defaultValue={project.compiler}>
                  {COMPILERS.map((c) => (
                    <option key={c} value={c}>
                      {c === 'pdflatex' ? 'pdfLaTeX' : c === 'xelatex' ? 'XeLaTeX' : 'LuaLaTeX'}
                    </option>
                  ))}
                </select>
              </label>{' '}
              <Once type="submit">Save compiler</Once>
            </form>
          )}
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
                    <td className="size">
                      {f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}
                    </td>
                    <td>{note(f.path, f.readonly)}</td>
                    <td className="actions">
                      {f.path === project.root && 'Root file '}
                      {canWrite && f.path !== project.root && !f.readonly && TEX.test(f.path) && (
                        <form action={rootAction.bind(null, id, f.id)} className="inline">
                          <Once type="submit" aria-label={`Make root file ${f.path}`}>
                            Make root
                          </Once>
                        </form>
                      )}{' '}
                      {canWrite && f.path !== project.root && (
                        <form action={deleteFileAction.bind(null, id, f.id)} className="inline">
                          <Once type="submit" className="danger" aria-label={`Delete ${f.path}`}>
                            Delete
                          </Once>
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
                            <Once type="submit">Rename</Once>
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
          <label>
            <input type="checkbox" name="replace" /> Replace the file of this name
          </label>
          <Once>Add file</Once>
        </DirectUpload>
      )}
      {report && (
        <>
          <h2>Import report</h2>
          <ul className="report">
            <li>{summarizeImport(report)}</li>
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
                {m.near ? (
                  <>
                    <code>{m.from}</code> refers to <code>{m.target}</code>. The paper has{' '}
                    <code>{m.near}</code>: only the capital letters differ, and here they count, as
                    they do on arXiv. The build will not find it until the name in{' '}
                    <code>{m.from}</code> matches the file.
                  </>
                ) : (
                  <>
                    <code>{m.from}</code> refers to <code>{m.target}</code>, which is not among the
                    paper&apos;s files. It may come with the TeX installation, which only a build
                    can tell.
                  </>
                )}
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
            {report.unnamable && report.unnamable.length > 0 && (
              <li>
                LaTeX cannot use these file names (they have % # &quot; {'{'} or {'}'}):{' '}
                <code>{report.unnamable.slice(0, 10).join(', ')}</code>
                {report.unnamable.length > 10 && ` and ${report.unnamable.length - 10} more`}.
                Rename them before using them.
              </li>
            )}
            {report.skipped.map((k) => (
              <li key={k.path}>
                Left out: <code>{k.path}</code> ({k.reason}).
              </li>
            ))}
            {report.skippedMore ? (
              <li>
                And {report.skippedMore} more {report.skippedMore === 1 ? 'file was' : 'files were'}{' '}
                left out.
              </li>
            ) : null}
          </ul>
        </>
      )}
    </>
  );
}
