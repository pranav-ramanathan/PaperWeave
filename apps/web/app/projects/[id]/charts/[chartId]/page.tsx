import {
  AppError,
  can,
  chartDraws,
  getProject,
  listCharts,
  listDatasets,
} from '@paperweave/server';
import Link from '../../../../Go';
import Once from '../../../../Once';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../../lib/server';
import { removeChartAction, saveChartAction } from '../../../actions';

export const dynamic = 'force-dynamic';

/** A chart: what it draws, how it stands, and the form that makes or changes it. */
export default async function ChartPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; chartId: string }>;
  searchParams: Promise<{ error?: string; data?: string }>;
}) {
  const { id, chartId } = await params;
  const { error, data } = await searchParams;
  const user = await requireUser(`/projects/${id}/charts/${chartId}`);
  const [project, datasets, charts] = await Promise.all([
    getProject(db(), user.id, id),
    listDatasets(db(), blobs(), user.id, id),
    listCharts(db(), blobs(), user.id, id),
  ]).catch((err) => {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  const chart = chartId === 'new' ? null : charts.find((c) => c.id === chartId);
  if (chartId !== 'new' && !chart) notFound();
  const draws = chart ? await chartDraws(db(), user.id, id, chart.name) : [];
  const dataset = datasets.find((d) => d.fileId === (chart?.dataFileId ?? data));
  const writer = can(project.role, 'file.write');
  const back = (
    <Link prefetch={false} href={`/projects/${id}#data`}>
      Back to the paper
    </Link>
  );
  const describe = dataset && (
    <Link prefetch={false} href={`/projects/${id}/data/${dataset.fileId}`}>
      Look at the data again
    </Link>
  );
  const spec = chart?.spec;
  // A drawing takes seconds. One that has waited two minutes is not being drawn, and a page
  // that went on loading itself every two seconds would do so for as long as it was open.
  const stuck =
    chart?.status === 'queued' &&
    !!chart.waitingSince &&
    Date.now() - Date.parse(chart.waitingSince) > 120_000;
  return (
    <main className="page">
      {/* Until it is drawn, look again every two seconds: but not for ever. */}
      {chart?.status === 'queued' && !stuck && <meta httpEquiv="refresh" content="2" />}
      <header className="bar">
        <h1>{chart ? `Chart ${chart.name}` : 'New chart'}</h1>
        {back}
      </header>
      {error && <p role="alert">{error}</p>}
      {chart?.status === 'queued' &&
        (stuck ? (
          <p role="alert">
            Still waiting to be drawn after two minutes. The service that draws charts may be busy
            or not running. Load this page again to look once more.
          </p>
        ) : (
          <p role="status">Waiting to be drawn…</p>
        ))}
      {chart?.status === 'failed' && <p role="alert">Could not be drawn: {chart.problem}</p>}
      {chart?.missing && (
        <p role="status">
          <strong>Not in the paper.</strong> This chart was drawn, but its files are no longer in
          the paper: they were deleted, or the paper was put back to how it was before the chart was
          drawn. Draw the chart again to put them back.
        </p>
      )}
      {chart?.drawnAt && !chart.missing && (
        <>
          <img
            className="chart"
            src={`/projects/${id}/charts/${chart.id}/png?at=${encodeURIComponent(chart.drawnAt)}`}
            alt={chart.alt}
          />
          <p>
            Drawn {chart.drawnAt.slice(0, 10)} from{' '}
            <code>{chart.dataPath ?? 'a deleted file'}</code>.{' '}
            {chart.leftOut
              ? `${chart.leftOut} ${chart.leftOut === 1 ? 'row' : 'rows'} with no value ${chart.leftOut === 1 ? 'was' : 'were'} left out. `
              : ''}
            Kept in the paper as <code>charts/{chart.name}.pdf</code> and{' '}
            <code>charts/{chart.name}.png</code>.
          </p>
        </>
      )}
      {chart?.stale && (
        <p role="status">
          <strong>Out of date.</strong> The data file has changed since this was drawn. {describe},
          then draw the chart again.
        </p>
      )}
      {dataset && (
        <p>
          The data: <code>{dataset.path}</code>, as approved on {dataset.approvedAt.slice(0, 10)}.
        </p>
      )}
      {!dataset ? (
        <p role="alert">
          {chart
            ? 'The data file of this chart has been deleted, or is no longer described.'
            : 'Choose a described data file on the paper’s page to make a chart from.'}
        </p>
      ) : (
        writer && (
          <form action={saveChartAction.bind(null, id, chart?.id ?? null, dataset.fileId)}>
            {!chart && (
              <>
                <label>
                  Name
                  <input
                    name="name"
                    required
                    maxLength={40}
                    // The hyphen is escaped: browsers read a pattern in a mode where a bare
                    // one inside brackets is an error, and then ignore the whole pattern.
                    pattern="[a-z0-9][a-z0-9\-]*"
                    title="Lower-case letters, digits and hyphens"
                    placeholder="latency-by-day"
                    aria-describedby="name-help"
                  />
                </label>
                <small id="name-help">
                  Lower-case letters, digits and hyphens. The chart&apos;s files take this name.
                </small>
              </>
            )}
            <label>
              Kind
              <select name="kind" defaultValue={spec?.kind ?? 'scatter'}>
                <option value="scatter">Scatter</option>
                <option value="line">Line</option>
                <option value="bar">Bar</option>
              </select>
            </label>
            <label>
              Along the bottom
              <select name="x" defaultValue={spec?.x}>
                {dataset.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.type})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Up the side
              <select name="y" defaultValue={spec?.y}>
                {dataset.columns
                  .filter((c) => c.type === 'number')
                  .map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Groups
              <select name="series" defaultValue={spec?.series ?? ''}>
                <option value="">None</option>
                {dataset.columns
                  .filter((c) => c.type === 'text')
                  .map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Rows with the same value along the bottom
              <select name="combine" defaultValue={spec?.combine ?? ''}>
                <option value="">Draw every row</option>
                <option value="mean">Draw their mean</option>
                <option value="sum">Draw their sum</option>
              </select>
            </label>
            <label>
              Where a line has no value
              <select name="gaps" defaultValue={spec?.gaps ?? 'break'}>
                <option value="break">Leave a gap</option>
                <option value="join">Join across it</option>
              </select>
            </label>
            <label>
              Title (optional)
              <input name="title" maxLength={120} defaultValue={spec?.title ?? ''} />
            </label>
            <label>
              Caption, for when the chart is put into the paper
              <input name="caption" maxLength={500} defaultValue={chart?.caption ?? ''} />
            </label>
            <label>
              Description, for people who cannot see the chart
              <input
                name="alt"
                maxLength={300}
                defaultValue={chart?.alt ?? ''}
                aria-describedby="alt-help"
              />
            </label>
            <small id="alt-help">Left empty, it says what kind of chart this is and of what.</small>
            <Once type="submit">{chart ? 'Draw it again' : 'Draw the chart'}</Once>
          </form>
        )
      )}
      {chart?.drawnAt && (
        <p>
          To put it into the paper, open a file in the visual editor, choose Figure, and pick{' '}
          <code>charts/{chart.name}.pdf</code>. Its caption and description are filled in for you.
        </p>
      )}
      {draws.length > 0 && (
        <>
          <h2>How it was made</h2>
          <ol className="report" reversed>
            {draws.map((d) => {
              const { data, chart: drawn, rowsLeftOut, generator } = d.record;
              return (
                <li key={d.pdf + d.drawnAt}>
                  {d.drawnAt.slice(0, 16).replace('T', ' ')} UTC: {drawn.kind} of{' '}
                  {drawn.combine ? `the ${drawn.combine} of ` : ''}
                  <code>{drawn.y}</code> against <code>{drawn.x}</code>
                  {drawn.series && (
                    <>
                      , by <code>{drawn.series}</code>
                    </>
                  )}
                  , from <code>{data.path}</code> version{' '}
                  <code title={data.sha256}>{data.sha256.slice(0, 12)}</code>.{' '}
                  {rowsLeftOut
                    ? `${rowsLeftOut} ${rowsLeftOut === 1 ? 'row' : 'rows'} with no value left out`
                    : 'No row left out'}
                  {data.missing.length > 0 &&
                    ` (no value: ${data.missing.map((m) => (m === '' ? 'an empty field' : m)).join(', ')})`}
                  . Drawn with Vega-Lite {generator['vega-lite']} and Vega {generator.vega}.
                </li>
              );
            })}
          </ol>
        </>
      )}
      {chart && writer && (
        <form action={removeChartAction.bind(null, id, chart.id)}>
          <Once type="submit">Remove this chart</Once>{' '}
          <small>Its files stay in the paper until you delete them.</small>
        </form>
      )}
    </main>
  );
}
