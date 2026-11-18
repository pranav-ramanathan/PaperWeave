// Reading a CSV file as a table, and guessing what its columns hold so that a person can say
// whether the guess is right. Nothing here decides: the author approves a schema.

const MAX_ROWS = 200_000;
const MAX_COLUMNS = 500;

export type Csv = { delimiter: ',' | ';' | '\t'; header: string[]; rows: string[][] };
export const COLUMN_TYPES = ['number', 'text', 'date'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/**
 * Parse CSV as RFC 4180 has it: a field in double quotes may hold the delimiter, line breaks and
 * doubled quotes. The delimiter is the one of comma, semicolon and tab that the first line has
 * most of, outside quotes. Throws a plain Error with a reason if the text is not a table.
 */
export function parseCsv(text: string): Csv {
  // Without a byte order mark, if it has one.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // The first line, quotes respected, decides the delimiter.
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  for (let i = 0, quoted = false; i < body.length; i++) {
    const c = body[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c]++;
  }
  const delimiter = (Object.keys(counts) as Csv['delimiter'][]).reduce((a, b) =>
    counts[b] > counts[a] ? b : a,
  );
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  /** True once the field has had a closing quote: only a delimiter or line end may follow. */
  let closed = false;
  const endField = () => {
    record.push(field);
    field = '';
    closed = false;
  };
  const endRecord = () => {
    endField();
    // A blank line is not a row.
    if (record.length > 1 || record[0] !== '') records.push(record);
    if (records.length > MAX_ROWS + 1) throw new Error(`it has more than ${MAX_ROWS} rows`);
    record = [];
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (body[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else if (c === delimiter) endField();
    else if (c === '\n') endRecord();
    else if (c === '\r') {
      if (body[i + 1] === '\n') i++;
      endRecord();
    } else if (closed) throw new Error(`row ${records.length + 1} has text after a closing quote`);
    else field += c;
  }
  if (quoted) throw new Error('a quoted field is never closed');
  if (field !== '' || record.length) endRecord();
  const [header, ...rows] = records;
  if (!header) throw new Error('it is empty');
  if (header.length > MAX_COLUMNS) throw new Error(`it has more than ${MAX_COLUMNS} columns`);
  const names = header.map((h) => h.trim());
  if (names.some((n) => !n)) throw new Error('a column has no name in the first row');
  if (new Set(names).size !== names.length) throw new Error('two columns have the same name');
  const short = rows.findIndex((r) => r.length !== names.length);
  if (short >= 0)
    throw new Error(
      `row ${short + 2} has ${rows[short].length} fields where the first row has ${names.length}`,
    );
  return { delimiter, header: names, rows };
}

/** A number as written in data: 3, -0.5, 1e-3. Not "1,000", which a person must decide about. */
export const asNumber = (value: string) =>
  /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim()) ? Number(value) : null;
/** A date as ISO 8601 writes it: 2024-03-01, optionally with a time. */
export const asDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(
    value.trim(),
  ) && !Number.isNaN(Date.parse(value.trim()))
    ? value.trim()
    : null;

/** Whether a value fits a column of a type. */
export const fits = (type: ColumnType, value: string) =>
  type === 'text' || (type === 'number' ? asNumber(value) !== null : asDate(value) !== null);

/** Spellings that commonly mean "no value". Which of them a file uses is for its author to say. */
export const MISSING_SPELLINGS = ['', 'NA', 'N/A', 'n/a', 'NaN', 'nan', 'null', 'NULL', '-', '?'];

/**
 * A guess at a schema, to put in front of the author: for each column the narrowest type all its
 * values fit once the spellings for "no value" found in the file are set aside, and how many
 * values are missing.
 */
export function guessSchema(csv: Csv) {
  const used = MISSING_SPELLINGS.filter((m) => csv.rows.some((r) => r.some((v) => v.trim() === m)));
  const missing = new Set(used);
  const columns = csv.header.map((name, j) => {
    const values = csv.rows.map((r) => r[j].trim());
    const present = values.filter((v) => !missing.has(v));
    const type: ColumnType =
      present.length && present.every((v) => asNumber(v) !== null)
        ? 'number'
        : present.length && present.every((v) => asDate(v) !== null)
          ? 'date'
          : 'text';
    // "Latency (ms)" and "latency_ms" are common ways to write a unit into a name.
    const unit = /\(([^()]+)\)\s*$/.exec(name)?.[1] ?? '';
    return {
      name,
      type,
      unit,
      missing: values.length - present.length,
      examples: present.slice(0, 3),
    };
  });
  return { columns, missing: used, rows: csv.rows.length };
}
