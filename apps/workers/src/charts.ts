// Takes queued charts from the charts table and draws them: Vega-Lite to SVG here, then SVG to
// PDF and PNG in the sandbox.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppError,
  type BlobStore,
  chartPath,
  datasetTable,
  type Db,
  putFile,
  recordDraw,
  transaction,
  vegaLite,
} from '@paperweave/server';
import type pg from 'pg';
import * as vega from 'vega';
import { compile, version as vegaLiteVersion } from 'vega-lite';
import { readOwn, sandbox } from './compile.ts';

/** The most a drawn chart file is read for: a chart is far smaller; a bigger file is no chart. */
const CHART_BYTES = 64 << 20;

/** Draw a Vega-Lite specification as SVG. */
export async function toSvg(vl: object): Promise<string> {
  const view = new vega.View(vega.parse(compile(vl as never).spec), { renderer: 'none' });
  const svg = await view.toSVG();
  view.finalize();
  return svg;
}

/** Draw a Vega-Lite specification as a PDF and a PNG. */
export async function render(vl: object): Promise<{ pdf: Uint8Array; png: Uint8Array }> {
  const svg = await toSvg(vl);
  const work = mkdtempSync(join(tmpdir(), 'paperweave-chart-'));
  try {
    writeFileSync(join(work, 'chart.svg'), svg);
    // Twice the size for the PNG, which is for screens. The PDF is what a paper should include.
    for (const args of [
      ['-f', 'pdf', '-o', 'chart.pdf'],
      ['-f', 'png', '-z', '2', '-o', 'chart.png'],
    ]) {
      // A fixed date, so that the same chart of the same data is the same file.
      const { code } = await sandbox(work, ['rsvg-convert', ...args, 'chart.svg'], 30, {
        SOURCE_DATE_EPOCH: '0',
      });
      if (code) throw new Error(`rsvg-convert ${args[1]} ended with ${code}`);
    }
    // rsvg-convert ran on a directory it could write to: read what it made without following links.
    const pdf = readOwn(work, join(work, 'chart.pdf'), CHART_BYTES);
    const png = readOwn(work, join(work, 'chart.png'), CHART_BYTES);
    if (!pdf || !png) throw new Error('rsvg-convert made no usable chart file');
    return { pdf, png };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Draw the queued chart to do next, if there is one. Returns whether there was. Not the oldest:
 * the one whose requester has had the fewest charts done in the last hour, then the one asked for
 * longest ago (`asked_at`, not when the chart was made), as `takeBuild` does for builds. Charts
 * from before requesters were recorded are one group of their own. A chart is counted once it is
 * done: while it is drawn it is locked and stays queued. The row stays locked while it is drawn:
 * if this process dies, the lock goes and another worker takes it.
 */
export function drawNext(pool: pg.Pool, store: BlobStore, image: string): Promise<boolean> {
  // The row is taken `skip locked`, so nobody waits on it, and this worker is next to the
  // database: it may sit between statements for a whole render.
  const run = async (db: Db) => {
    const job = (
      await db.query(
        `select c.id, c.project_id, c.name, c.dataset_file_id, c.spec from charts c
         where c.status = 'queued'
         order by (select count(*) from charts d
                   where d.requested_by is not distinct from c.requested_by and d.status <> 'queued'
                     and d.asked_at > now() - interval '1 hour'),
                  c.asked_at
         for update of c skip locked limit 1`,
      )
    ).rows[0];
    if (!job) return false;
    try {
      // Read with the approved description, and only if the file is still the approved version.
      const table = await datasetTable(db, store, job.project_id, job.dataset_file_id);
      const { vl, leftOut } = vegaLite(job.spec, table);
      const { pdf, png } = await render(vl);
      await recordDraw(db, job.project_id, job.name, {
        pdf: await putFile(db, store, job.project_id, chartPath(job.name, 'pdf'), pdf),
        png: await putFile(db, store, job.project_id, chartPath(job.name, 'png'), png),
        record: {
          data: {
            path: table.path,
            sha256: table.version,
            // Only what the chart uses of the description: its columns, and what means no value.
            columns: table.columns.filter((c) =>
              [job.spec.x, job.spec.y, job.spec.series].includes(c.name),
            ),
            missing: table.missing,
          },
          chart: job.spec,
          rowsLeftOut: leftOut,
          generator: { vega: vega.version, 'vega-lite': vegaLiteVersion, image },
        },
      });
      await db.query(
        `update charts set status = 'drawn', problem = null, drawn_digest = $2, left_out = $3,
           drawn_at = clock_timestamp() where id = $1`,
        [job.id, table.version, leftOut],
      );
    } catch (err) {
      // Something the author can put right is said in full. Anything else is ours: its text may
      // quote the data, so only its kind is logged.
      const ours = !(err instanceof AppError);
      if (ours) console.error(`chart ${job.id} could not be drawn:`, (err as Error).name);
      await db.query("update charts set status = 'failed', problem = $2 where id = $1", [
        job.id,
        ours ? 'The chart service could not draw this chart. Try again.' : (err as Error).message,
      ]);
    }
    return true;
  };
  return transaction(pool, run, 0);
}
