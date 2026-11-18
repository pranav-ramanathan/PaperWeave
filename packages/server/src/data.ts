// Datasets: CSV files of a paper that their author has described. A description is approved by
// a person and is of one exact version of the file.
import { decodeFile } from '@paperweave/latex';
import type pg from 'pg';
import { authorize } from './authz.ts';
import { type BlobStore, sha256 } from './blobs.ts';
import {
  asDate,
  asNumber,
  COLUMN_TYPES,
  type ColumnType,
  type Csv,
  fits,
  guessSchema,
  parseCsv,
} from './csv.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { currentBytes } from './sync.ts';

export type Column = { name: string; type: ColumnType; unit: string };
export type Dataset = {
  fileId: string;
  path: string;
  columns: Column[];
  missing: string[];
  attribution: string;
  exported: boolean;
  approvedBy: string | null;
  approvedAt: string;
  /** The version that was approved: the sha256 of the file then. */
  version: string;
  /** The file has been changed since. Charts drawn from the approved version are out of date. */
  changed: boolean;
};

/** A paper's CSV file as it stands: its table and the digest that names this version of it. */
async function readCsv(db: Db, store: BlobStore, projectId: string, fileId: string) {
  const file = (
    await db.query(
      `select id, path, digest, eol, bom, head_seq from files
       where id = $1 and project_id = $2 and path ~* '\\.(csv|tsv)$'`,
      [id(fileId), projectId],
    )
  ).rows[0];
  if (!file) throw new AppError('not_found', 'No such data file.');
  const bytes = await currentBytes(db, store, file);
  const decoded = decodeFile(bytes);
  const unusable = (why: string) =>
    new AppError('invalid_input', `${file.path} cannot be used as data: ${why}.`);
  if (!decoded.editable) throw unusable('it is not UTF-8 text');
  let csv: Csv;
  try {
    csv = parseCsv(decoded.text);
  } catch (err) {
    throw unusable((err as Error).message);
  }
  return { path: file.path as string, csv, version: sha256(bytes) };
}

/**
 * What a CSV file looks like it holds, for its author to check, with the description approved
 * before if there is one.
 */
export async function datasetProposal(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId: string,
) {
  await authorize(pool, userId, id(projectId), 'project.read');
  const { path, csv, version } = await readCsv(pool, store, projectId, fileId);
  const approved = (await listDatasets(pool, store, userId, projectId)).find(
    (d) => d.fileId === fileId,
  );
  return { path, version, guess: guessSchema(csv), approved: approved ?? null };
}

/**
 * Record the author's description of a CSV file. It is of the version of the file they were
 * shown (`version`): if the file has changed since, nothing is recorded. Every value must fit
 * the type its column is given, or be one of the spellings for "no value".
 */
export async function approveDataset(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId: string,
  input: {
    version: unknown;
    columns: unknown;
    missing: unknown;
    attribution?: unknown;
    exported?: unknown;
  },
): Promise<void> {
  await authorize(pool, userId, id(projectId), 'file.write');
  const { csv, version } = await readCsv(pool, store, projectId, fileId);
  if (input.version !== version)
    throw new AppError('conflict', 'The file has changed since you looked at it. Look again.');
  const bad = (why: string) => new AppError('invalid_input', why);
  if (!Array.isArray(input.columns) || input.columns.length !== csv.header.length)
    throw bad('Describe every column of the file, in its order.');
  const columns: Column[] = input.columns.map((c: Partial<Column> | null, j: number) => {
    if (c?.name !== csv.header[j]) throw bad(`Column ${j + 1} of the file is "${csv.header[j]}".`);
    if (!COLUMN_TYPES.includes(c.type as ColumnType))
      throw bad(`Say whether "${c.name}" holds numbers, dates or text.`);
    const unit = typeof c.unit === 'string' ? c.unit.trim() : '';
    if (unit.length > 40) throw bad(`The unit of "${c.name}" is too long.`);
    return { name: c.name, type: c.type as ColumnType, unit };
  });
  if (
    !Array.isArray(input.missing) ||
    input.missing.length > 20 ||
    input.missing.some((m) => typeof m !== 'string' || m.length > 20)
  )
    throw bad('Give the spellings that mean "no value" as a short list.');
  const missing = [...new Set((input.missing as string[]).map((m) => m.trim()))];
  const attribution = typeof input.attribution === 'string' ? input.attribution.trim() : '';
  if (attribution.length > 2000) throw bad('The note on where the data came from is too long.');
  csv.rows.forEach((row, i) =>
    row.forEach((value, j) => {
      const v = value.trim();
      if (missing.includes(v) || fits(columns[j].type, v)) return;
      // The header is row 1.
      throw bad(
        `"${columns[j].name}", row ${i + 2}: "${v.slice(0, 40)}" is not a ${columns[j].type}. Change the column's type, or add that spelling to those that mean "no value".`,
      );
    }),
  );
  await pool.query(
    `insert into datasets (file_id, project_id, columns, missing, attribution, exported, approved_digest, approved_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (file_id) do update set columns = excluded.columns, missing = excluded.missing,
       attribution = excluded.attribution, exported = excluded.exported,
       approved_digest = excluded.approved_digest, approved_by = excluded.approved_by,
       approved_at = now()`,
    [
      fileId,
      projectId,
      JSON.stringify(columns),
      JSON.stringify(missing),
      attribution,
      input.exported === true,
      version,
      userId,
    ],
  );
}

/** Every described dataset of a paper, and whether its file has changed since. */
export async function listDatasets(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<Dataset[]> {
  await authorize(pool, userId, id(projectId), 'project.read');
  const { rows } = await pool.query(
    `select d.file_id, d.columns, d.missing, d.attribution, d.exported, d.approved_digest,
            d.approved_at, u.email, f.path, f.digest, f.eol, f.bom, f.head_seq
     from datasets d join files f on f.id = d.file_id left join "user" u on u.id = d.approved_by
     where d.project_id = $1 order by f.path`,
    [projectId],
  );
  const out: Dataset[] = [];
  for (const r of rows)
    out.push({
      fileId: r.file_id,
      path: r.path,
      columns: r.columns,
      missing: r.missing,
      attribution: r.attribution,
      exported: r.exported,
      approvedBy: r.email,
      approvedAt: r.approved_at.toISOString(),
      version: r.approved_digest,
      changed:
        sha256(await currentBytes(pool, store, { ...r, id: r.file_id })) !== r.approved_digest,
    });
  return out;
}

/**
 * A dataset as typed values, read with its approved description: a number, a date as written,
 * text, or null for "no value". Only the approved version is ever read this way: if the file has
 * changed since, this refuses, so that nothing is drawn from data nobody has looked at.
 */
export async function datasetTable(db: Db, store: BlobStore, projectId: string, fileId: string) {
  const described = (
    await db.query(
      'select columns, missing, approved_digest from datasets where file_id = $1 and project_id = $2',
      [id(fileId), projectId],
    )
  ).rows[0];
  if (!described) throw new AppError('invalid_input', 'That file has not been described as data.');
  const { path, csv, version } = await readCsv(db, store, projectId, fileId);
  if (version !== described.approved_digest)
    throw new AppError(
      'conflict',
      `${path} has changed since its description was approved. Look at it again first.`,
    );
  const columns: Column[] = described.columns;
  const missing: string[] = described.missing;
  const rows = csv.rows.map((row) =>
    row.map((value, j) => {
      const v = value.trim();
      if (missing.includes(v)) return null;
      return columns[j].type === 'number'
        ? asNumber(v)
        : columns[j].type === 'date'
          ? asDate(v)
          : v;
    }),
  );
  return { path, columns, missing, rows, version };
}
