-- A chart drawn from a described data file. Its files are charts/<name>.pdf and
-- charts/<name>.png in the paper. Queued rows are the chart worker's queue.
create table charts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  name text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  dataset_file_id uuid not null references all_files on delete cascade,
  -- {"kind": "line", "x": "day", "y": "latency", "series": null, "combine": null,
  --  "gaps": "break", "title": ""}
  spec jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'drawn', 'failed')),
  -- Why it could not be drawn, in words for its author.
  problem text,
  -- The version (sha256) of the data file the chart's files were drawn from. When the file's
  -- now differs, the chart is out of date.
  drawn_digest text,
  -- Rows left out because they had no value.
  left_out int,
  created_by uuid references "user" on delete set null,
  created_at timestamptz not null default now(),
  drawn_at timestamptz,
  unique (project_id, name)
);
create index charts_queued on charts (created_at) where status = 'queued';
