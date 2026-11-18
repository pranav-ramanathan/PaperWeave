-- A CSV file whose author has looked at it and said what it holds: what each column is and in
-- what unit, which spellings mean "no value", and where the data came from.
create table datasets (
  file_id uuid primary key references all_files on delete cascade,
  project_id uuid not null references projects on delete cascade,
  -- [{"name": "latency (ms)", "type": "number", "unit": "ms"}, ...], in the file's column order.
  columns jsonb not null,
  -- ["", "NA"]
  missing jsonb not null,
  attribution text not null default '' check (length(attribution) <= 2000),
  -- Whether the file goes into downloads of the paper. Data is not passed on unless its author
  -- says so.
  exported boolean not null default false,
  -- The sha256 of the file as it was approved: the dataset's version. If the file's now
  -- differs, the approval is of an older version.
  approved_digest text not null check (approved_digest ~ '^[0-9a-f]{64}$'),
  approved_by uuid references "user" on delete set null,
  approved_at timestamptz not null default now()
);
create index datasets_project on datasets (project_id);
