import { heldReadMessage, type listCharts, type listDatasets } from '@paperweave/server';
import Link from '../../../Go';
import Result from '../../../Result';

type Datasets = Awaited<ReturnType<typeof listDatasets>>;
type Charts = Awaited<ReturnType<typeof listCharts>>;
type DataFile = { id: string; path: string };

/** Shown after a dataset's description was approved. */
export function DescribedNotice({ described }: { described?: string }) {
  return <>{described && <Result>Description approved.</Result>}</>;
}

/** Shown after a chart was removed. */
export function ChartRemovedNotice({ chartRemoved }: { chartRemoved?: string }) {
  return (
    <>
      {chartRemoved && (
        <Result>
          Removed the chart <code>{chartRemoved}</code>.
        </Result>
      )}
    </>
  );
}

/** The CSV files that can become data, and the charts drawn from them. */
export function Data({
  id,
  dataFiles,
  datasets,
  charts,
  heldReads,
  canWrite,
  show,
}: {
  id: string;
  dataFiles: DataFile[];
  datasets: Datasets;
  charts: Charts;
  heldReads: Set<string>;
  canWrite: boolean;
  show: boolean;
}) {
  return (
    <>
      {show && (
        <>
          <h2 id="data" tabIndex={-1}>
            Data
          </h2>
          <p>
            A CSV file becomes data once someone has said what its columns hold. Charts are drawn
            only from a file as it was when its description was approved.
          </p>
          <ul className="report ruled">
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
              <ul className="report ruled">
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
                        <strong>
                          {c.changed === 'settings'
                            ? 'Out of date: the paper holds a drawing made with other settings. Draw it again.'
                            : 'Out of date: its data has changed since it was drawn.'}
                        </strong>
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
    </>
  );
}
