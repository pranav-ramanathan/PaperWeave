import type { labelReport } from '@paperweave/server';
import Link from '../../../Go';
import Result from '../../../Result';

type Labels = Awaited<ReturnType<typeof labelReport>>;

/** Shown after a label was renamed. */
export function RelabelledNotice({ relabelled, places }: { relabelled?: string; places?: string }) {
  return (
    <>
      {relabelled && (
        <Result>
          Renamed to <code>{relabelled}</code> in {places} {places === '1' ? 'place' : 'places'}.
        </Result>
      )}
    </>
  );
}

/** Labels and references: what is undefined or defined twice, and the rename form. */
export function Labels({
  id,
  labels,
  canWrite,
  show,
}: {
  id: string;
  labels: Labels;
  canWrite: boolean;
  show: boolean;
}) {
  return (
    <>
      {show && (
        <>
          <h2 id="labels" tabIndex={-1}>
            Labels and references
          </h2>
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
    </>
  );
}
