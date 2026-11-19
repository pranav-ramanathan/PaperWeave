// Charts: a scatter, line or bar chart of two columns of a described data file. The chart worker
// draws it to a PDF and a PNG, which are kept as files of the paper under charts/.
import { cellText } from '@paperweave/latex';
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
  /** The chart in a sentence, for people who cannot see it: its author's words, or ours. */
  alt: string;
  caption: string;
  /** The version (sha256) of the data file it was drawn from. */
  version: string | null;
};
/** One drawing of a chart: what it was made from, and with what. */
export type ChartDraw = {
  drawnAt: string;
  pdf: string;
  png: string;
  record: {
    data: { path: string; sha256: string; columns: Column[]; missing: string[] };
    chart: ChartSpec;
    rowsLeftOut: number;
    generator: Record<string, string>;
  };
};

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_GROUPS = 8;
/**
 * The colours of a chart's groups, in the order they are used. A chart is printed on white, so
 * each is dark enough against white to be made out (3 to 1, what WCAG asks of graphics): three
 * of the eight used before were not, the second among them.
 *
 * The first seven are from Paul Tol's "muted" scheme, chosen to stay apart for colour-blind
 * readers. The eighth is his teal made darker. That they stay apart was checked by simulating
 * colour-blind vision, not by people. Groups are told apart without colour too: by the shape of
 * a point, the dashes of a line, the place of a bar.
 */
export const CHART_COLOURS = [
  '#332288',
  '#CC6677',
  '#117733',
  '#999933',
  '#AA4499',
  '#882255',
  '#000000',
  '#44A0A4',
];
/** Drawings of one paper's charts in an hour. */
export const CHART_DRAWS_PER_HOUR = 120;
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
      mark: { color: CHART_COLOURS[0] },
      range: { category: CHART_COLOURS },
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
  perHour = CHART_DRAWS_PER_HOUR,
): Promise<string> {
  await authorize(pool, userId, id(projectId), 'file.write');
  // Each drawing runs a sandbox, as a build does, and is held to the same number.
  const drawn = await pool.query(
    "select count(*)::int as n from chart_requests where project_id = $1 and created_at > now() - interval '1 hour'",
    [projectId],
  );
  if (drawn.rows[0].n >= perHour)
    throw new AppError(
      'conflict',
      `This paper's charts have been drawn ${perHour} times in the last hour. Try again in a little while.`,
    );
  const existing = input.id
    ? (
        await pool.query(
          'select id, name, dataset_file_id, spec from charts where id = $1 and project_id = $2',
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
  const words = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  // Both go into LaTeX as they are when the chart is put into the paper.
  const caption = words(input.caption);
  if (caption.length > 500 || !cellText(caption))
    throw bad('A caption cannot hold an unescaped & or %, and its braces must match.');
  const given = words(input.alt);
  if (given.length > 300 || /[{}%#\\\]]/.test(given))
    throw bad('A description cannot hold { } % # ] or a backslash. Say it in plain words.');
  // Left empty, or left as we wrote it for the chart as it was: our own sentence for this chart.
  const ours = existing && describeChart(existing.spec, table.columns);
  const alt = !given || given === ours ? describeChart(spec, table.columns) : given;
  // Counted from here: this one will be drawn.
  await pool.query(
    `with old as (
       delete from chart_requests where project_id = $1 and created_at < now() - interval '1 day'
     ) insert into chart_requests (project_id) values ($1)`,
    [projectId],
  );
  if (existing) {
    await pool.query(
      `update charts set spec = $2, caption = $3, alt = $4, status = 'queued', problem = null
       where id = $1`,
      [existing.id, JSON.stringify(spec), caption, alt],
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
            `insert into charts (project_id, name, dataset_file_id, spec, created_by, caption, alt)
             values ($1, $2, $3, $4, $5, $6, $7) returning id`,
            [projectId, name, dataset, JSON.stringify(spec), userId, caption, alt],
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
            c.drawn_digest, c.caption, c.alt, f.path, f.digest, f.eol, f.bom, f.head_seq
     from charts c left join files f on f.id = c.dataset_file_id
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
      alt: r.alt,
      caption: r.caption,
      version: r.drawn_digest,
    });
  }
  return out;
}

/**
 * Write down one drawing of a chart, for the worker. Drawing the same chart of the same data
 * with the same tools again adds nothing.
 */
export async function recordDraw(
  db: Db,
  projectId: string,
  name: string,
  draw: Omit<ChartDraw, 'drawnAt'>,
) {
  await db.query(
    `insert into chart_draws (project_id, name, pdf_digest, png_digest, record)
     select $1, $2, $3, $4, $5::jsonb where not exists (
       select 1 from chart_draws
       where project_id = $1 and name = $2 and pdf_digest = $3 and png_digest = $4 and record = $5::jsonb)`,
    [projectId, name, draw.pdf, draw.png, JSON.stringify(draw.record)],
  );
}

/** Every drawing of a chart, newest first. */
export async function chartDraws(
  db: Db,
  userId: string,
  projectId: string,
  name: string,
): Promise<ChartDraw[]> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select drawn_at, pdf_digest, png_digest, record from chart_draws
     where project_id = $1 and name = $2 order by id desc`,
    [projectId, name],
  );
  return rows.map((r) => ({
    drawnAt: r.drawn_at.toISOString(),
    pdf: r.pdf_digest,
    png: r.png_digest,
    record: r.record,
  }));
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
