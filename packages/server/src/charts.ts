// Charts: a scatter, line or bar chart of two columns of a described data file. The chart worker
// draws it to a PDF and a PNG, which are kept as files of the paper under charts/.
import type pg from 'pg';
import { authorize } from './authz.ts';
import { type BlobStore, sha256 } from './blobs.ts';
import { type Column, datasetTable } from './data.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { currentBytes } from './sync.ts';

export const CHART_KINDS = ['scatter', 'line', 'bar'] as const;
export type ChartSpec = {
  kind: (typeof CHART_KINDS)[number];
  /** Column names of the data file. */
  x: string;
  y: string;
  /** A text column that splits the rows into groups, each drawn in its own colour. */
  series: string | null;
  /** How rows with the same x (and group) become one value. Null: every row is drawn. */
  combine: 'mean' | 'sum' | null;
  /** A line where a value is missing: broken there, or joined across. */
  gaps: 'break' | 'join';
  title: string;
};
export type Table = { columns: Column[]; rows: (number | string | null)[][] };
export type Chart = {
  id: string;
  name: string;
  /** Null when the data file has been deleted. */
  dataPath: string | null;
  dataFileId: string;
  spec: ChartSpec;
  status: 'queued' | 'drawn' | 'failed';
  /** Why it could not be drawn. */
  problem: string | null;
  /** Rows that were left out because they had no value. */
  leftOut: number | null;
  drawnAt: string | null;
  /** The data file is no longer the version this was drawn from. */
  stale: boolean;
  /** The chart in a sentence, for people who cannot see it. */
  alt: string;
};

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_GROUPS = 8;
const bad = (why: string) => new AppError('invalid_input', why);
/** Where a chart's files are kept in the paper. */
export const chartPath = (name: string, ext: 'pdf' | 'png') => `charts/${name}.${ext}`;
/** A column's name with its unit, unless the name already says it. */
const titled = (c: Column) =>
  c.unit && !c.name.includes(`(${c.unit})`) ? `${c.name} (${c.unit})` : c.name;

/**
 * A date as written, read as UTC unless it names a zone. The chart's axis is in UTC too, so a
 * date is drawn where it was written whatever the clock of the machine that draws it.
 */
const utc = (date: string) => {
  const t = date.replace(' ', 'T');
  return t.length > 10 && !/(Z|[+-]\d{2}:?\d{2})$/.test(t) ? `${t}Z` : t;
};

/** Check a chart against the columns of its data file. */
export function checkChart(input: Record<string, unknown>, columns: Column[]): ChartSpec {
  const column = (what: string, name: unknown) => {
    const found = columns.find((c) => c.name === name);
    if (!found) throw bad(`Choose a column of the data file for ${what}.`);
    return found;
  };
  const kind = input.kind as ChartSpec['kind'];
  if (!CHART_KINDS.includes(kind)) throw bad('Choose a scatter, line or bar chart.');
  const x = column('the horizontal axis', input.x);
  const y = column('the vertical axis', input.y);
  if (x.name === y.name) throw bad('The two axes need different columns.');
  if (y.type !== 'number')
    throw bad(`The vertical axis needs numbers; "${y.name}" holds ${y.type}.`);
  if (kind !== 'bar' && x.type === 'text')
    throw bad(`A ${kind} chart needs numbers or dates along the bottom; "${x.name}" holds text.`);
  const series = input.series ? column('the groups', input.series) : null;
  if (series && (series.type !== 'text' || series.name === x.name))
    throw bad('Groups need a text column that is not one of the axes.');
  const combine = input.combine ? (input.combine as ChartSpec['combine']) : null;
  if (combine && combine !== 'mean' && combine !== 'sum') throw bad('Combine rows by mean or sum.');
  if (combine && kind === 'scatter') throw bad('A scatter chart draws every row as it is.');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length > 120) throw bad('The title is too long.');
  return {
    kind,
    x: x.name,
    y: y.name,
    series: series?.name ?? null,
    combine,
    gaps: input.gaps === 'join' ? 'join' : 'break',
    title,
  };
}

/** The chart in a sentence. */
export function describeChart(spec: ChartSpec, columns: Column[]): string {
  const of = (name: string) => {
    const c = columns.find((x) => x.name === name);
    return c ? titled(c) : name;
  };
  const kind = spec.kind[0].toUpperCase() + spec.kind.slice(1);
  return `${kind} chart of ${spec.combine ? `the ${spec.combine} of ` : ''}${of(spec.y)} against ${of(spec.x)}${spec.series ? `, by ${of(spec.series)}` : ''}.`;
}

/**
 * The Vega-Lite specification of a chart, with its data. Rows that cannot be placed (no x, no
 * group, or no y where a gap cannot be shown) are left out and counted.
 */
export function vegaLite(spec: ChartSpec, table: Table) {
  const at = (name: string | null) => table.columns.findIndex((c) => c.name === name);
  const [x, y, s] = [at(spec.x), at(spec.y), at(spec.series)];
  if (x < 0 || y < 0 || (spec.series && s < 0))
    throw bad('The data file no longer has a column this chart uses. Choose its columns again.');
  const dated = table.columns[x].type === 'date';
  // A line can show a missing value as a gap. Everything else has nothing to draw for it.
  const gap = spec.kind === 'line' && spec.gaps === 'break' && !spec.combine;
  const values = table.rows
    .filter((r) => r[x] !== null && (s < 0 || r[s] !== null) && (gap || r[y] !== null))
    // Fixed names: a column's own name may hold characters that mean something to Vega.
    .map((r) => ({
      x: dated ? utc(r[x] as string) : r[x],
      y: r[y],
      ...(s < 0 ? {} : { s: r[s] }),
    }));
  if (!values.some((v) => v.y !== null)) throw bad('No row has a value on both axes.');
  const groups = new Set(values.map((v) => v.s));
  if (groups.size > MAX_GROUPS)
    throw bad(`"${spec.series}" has ${groups.size} groups; a chart can show ${MAX_GROUPS}.`);
  if (spec.kind === 'bar' && !spec.combine) {
    const seen = new Set(values.map((v) => JSON.stringify([v.x, v.s])));
    if (seen.size < values.length)
      throw bad(
        `Several rows share a value of "${spec.x}". Say how to combine them: by mean or by sum.`,
      );
  }
  const xType = { number: 'quantitative', date: 'temporal', text: 'nominal' }[
    table.columns[x].type
  ];
  const yTitle = titled(table.columns[y]);
  const group = { field: 's', type: 'nominal', title: s < 0 ? '' : titled(table.columns[s]) };
  const vl = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: 360,
    height: 240,
    background: 'white',
    ...(spec.title ? { title: spec.title } : {}),
    data: { values },
    mark:
      spec.kind === 'scatter'
        ? { type: 'point' }
        : spec.kind === 'bar'
          ? { type: 'bar' }
          : {
              type: 'line',
              point: true,
              ...(gap ? { invalid: 'break-paths-show-path-domains' } : {}),
            },
    encoding: {
      // Bars keep the order of the file.
      x: {
        field: 'x',
        type: xType,
        title: titled(table.columns[x]),
        ...(dated ? { scale: { type: 'utc' } } : {}),
        ...(spec.kind === 'bar' ? { sort: null } : {}),
        // A few names fit side by side; more are turned on their side, as Vega-Lite does.
        ...(xType === 'nominal' && new Set(values.map((v) => v.x)).size <= 6
          ? { axis: { labelAngle: 0 } }
          : {}),
      },
      y: {
        field: 'y',
        type: 'quantitative',
        title: spec.combine ? `${spec.combine} of ${yTitle}` : yTitle,
        ...(spec.combine ? { aggregate: spec.combine } : {}),
      },
      ...(s < 0
        ? {}
        : {
            color: group,
            // Told apart without colour too: by shape, by dash, or by place.
            ...(spec.kind === 'scatter' ? { shape: group } : {}),
            ...(spec.kind === 'line' ? { strokeDash: group } : {}),
            ...(spec.kind === 'bar' ? { xOffset: { field: 's', type: 'nominal' } } : {}),
          }),
    },
    config: {
      // The one font family in the image that draws the chart.
      font: 'DejaVu Sans',
      mark: { color: '#0072B2' },
      // Colours that stay distinct for colour-blind readers (Okabe and Ito).
      range: {
        category: [
          '#0072B2',
          '#E69F00',
          '#009E73',
          '#CC79A7',
          '#56B4E9',
          '#D55E00',
          '#F0E442',
          '#000000',
        ],
      },
    },
  };
  return { vl, leftOut: table.rows.length - values.length };
}

/**
 * Make a chart, or change one (`input.id`), and queue it to be drawn. A chart is only ever made
 * from a data file whose description is approved and current.
 */
export async function saveChart(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  input: Record<string, unknown>,
): Promise<string> {
  await authorize(pool, userId, id(projectId), 'file.write');
  const existing = input.id
    ? (
        await pool.query(
          'select id, name, dataset_file_id from charts where id = $1 and project_id = $2',
          [id(String(input.id)), projectId],
        )
      ).rows[0]
    : null;
  if (input.id && !existing) throw new AppError('not_found', 'No such chart.');
  const name = existing?.name ?? input.name;
  if (typeof name !== 'string' || !NAME.test(name))
    throw bad('Give the chart a short name of lower-case letters, digits and hyphens.');
  const dataset: string = existing?.dataset_file_id ?? id(String(input.dataset ?? ''));
  const table = await datasetTable(pool, store, projectId, dataset);
  const spec = checkChart(input, table.columns);
  // Found now rather than by the worker: a chart that cannot be drawn from this data.
  vegaLite(spec, table);
  if (existing) {
    await pool.query(
      "update charts set spec = $2, status = 'queued', problem = null where id = $1",
      [existing.id, JSON.stringify(spec)],
    );
  } else {
    // The chart's files must not take the place of files someone put there.
    const taken = await pool.query('select 1 from files where project_id = $1 and path = any($2)', [
      projectId,
      [chartPath(name, 'pdf'), chartPath(name, 'png')],
    ]);
    if (taken.rowCount)
      throw new AppError('conflict', `The paper already has a file charts/${name}.`);
  }
  const made = existing
    ? existing
    : (
        await pool
          .query(
            `insert into charts (project_id, name, dataset_file_id, spec, created_by)
             values ($1, $2, $3, $4, $5) returning id`,
            [projectId, name, dataset, JSON.stringify(spec), userId],
          )
          .catch((err) => {
            if (err.code === '23505')
              throw new AppError('conflict', 'Another chart already has that name.');
            throw err;
          })
      ).rows[0];
  await pool.query("select pg_notify('charts', $1)", [made.id]);
  return made.id;
}

/** Every chart of a paper, and whether its data has changed since it was drawn. */
export async function listCharts(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<Chart[]> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const { rows } = await pool.query(
    `select c.id, c.name, c.dataset_file_id, c.spec, c.status, c.problem, c.left_out, c.drawn_at,
            c.drawn_digest, d.columns, f.path, f.digest, f.eol, f.bom, f.head_seq
     from charts c left join files f on f.id = c.dataset_file_id
     left join datasets d on d.file_id = c.dataset_file_id
     where c.project_id = $1 order by c.name`,
    [projectId],
  );
  const versions = new Map<string, string>();
  const out: Chart[] = [];
  for (const r of rows) {
    if (r.path && !versions.has(r.dataset_file_id))
      versions.set(
        r.dataset_file_id,
        sha256(await currentBytes(pool, store, { ...r, id: r.dataset_file_id })),
      );
    out.push({
      id: r.id,
      name: r.name,
      dataPath: r.path,
      dataFileId: r.dataset_file_id,
      spec: r.spec,
      status: r.status,
      problem: r.problem,
      leftOut: r.left_out,
      drawnAt: r.drawn_at?.toISOString() ?? null,
      stale: r.status === 'drawn' && versions.get(r.dataset_file_id) !== r.drawn_digest,
      alt: describeChart(r.spec, r.columns ?? []),
    });
  }
  return out;
}

/** Take a chart off the paper's list. Its files stay in the paper until someone deletes them. */
export async function removeChart(db: Db, userId: string, projectId: string, chartId: string) {
  await authorize(db, userId, id(projectId), 'file.write');
  const gone = await db.query('delete from charts where id = $1 and project_id = $2', [
    id(chartId),
    projectId,
  ]);
  if (!gone.rowCount) throw new AppError('not_found', 'No such chart.');
}

/** A drawn chart as a PNG, for showing on a page. */
export async function chartPng(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
  chartId: string,
): Promise<Uint8Array> {
  await authorize(db, userId, id(projectId), 'project.read');
  const found = (
    await db.query(
      `select f.digest from charts c join files f
         on f.project_id = c.project_id and f.path = 'charts/' || c.name || '.png'
       where c.id = $1 and c.project_id = $2 and c.drawn_at is not null`,
      [id(chartId), projectId],
    )
  ).rows[0];
  const bytes = found && (await store.get(found.digest));
  if (!bytes) throw new AppError('not_found', 'That chart has not been drawn.');
  return bytes;
}
