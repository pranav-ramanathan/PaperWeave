import {
  can,
  heldLine,
  REVISIONS_SHOWN,
  type heldInRevisions,
  type listRevisions,
} from '@paperweave/server';
import Once from '../../../Once';
import { Wide } from '../../../Wide';
import Link from '../../../Go';
import Result from '../../../Result';
import { called, NOW, since } from '../../../../lib/compare';
import type { paperOf } from '../../../../lib/server';
import {
  buildRevisionAction,
  compareAction,
  restoreAction,
  saveRevisionAction,
} from '../../actions';

type Revisions = Awaited<ReturnType<typeof listRevisions>>;
type HeldBy = Awaited<ReturnType<typeof heldInRevisions>>;
type Project = Awaited<ReturnType<typeof paperOf>>;

/** Saved revisions: saving one, comparing two, downloading and restoring. */
export function RevisionsSection({
  id,
  project,
  revisions,
  heldBy,
  olderAutos,
  oldestAuto,
  olderThan,
  saved,
  restored,
  building,
}: {
  id: string;
  project: Project;
  revisions: Revisions;
  heldBy: HeldBy;
  /** How many automatic revisions there are before the oldest one shown. */
  olderAutos: number;
  oldestAuto: number | undefined;
  /** The number the page was asked to list the revisions below, if any. */
  olderThan: number | undefined;
  /** The `revision` parameter: the number just saved. */
  saved?: string;
  restored?: string;
  building?: string;
}) {
  const writer = can(project.role, 'revision.write');
  return (
    <>
      <h2 id="revisions" tabIndex={-1}>
        Revisions
      </h2>
      {saved && <Result>Saved as revision {saved}.</Result>}
      {restored && <Result>Restored. The paper is now revision {restored}.</Result>}
      {building && <Result>Building the PDF for that revision. Reload in a moment.</Result>}
      <p>
        A revision is the whole paper at one moment. Its ZIP and its PDF always belong together.
      </p>
      {writer && (
        <form action={saveRevisionAction.bind(null, id)}>
          <label>
            Name for the paper as it is now
            <input name="name" required maxLength={200} placeholder="Submitted to the workshop" />
          </label>
          <Once type="submit">Save revision</Once>
        </form>
      )}
      {revisions.length > 0 && (
        <form action={compareAction.bind(null, id)}>
          <label>
            Changes from
            <select name="from" defaultValue={since(revisions, writer)}>
              {revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {called(r)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Changes up to
            <select name="to" defaultValue={writer ? NOW : revisions[0].id}>
              {writer && <option value={NOW}>The paper as it is now</option>}
              {revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {called(r)}
                </option>
              ))}
            </select>
          </label>
          <Once type="submit">Show the changes</Once>
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
                          <Once type="submit" aria-label={`Build PDF for revision ${r.number}`}>
                            Build PDF
                          </Once>
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
                        <Once type="submit" aria-label={`Restore revision ${r.number}`}>
                          Restore
                        </Once>
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
    </>
  );
}
