-- What a chart says in the paper: its caption, and its description for people who cannot see it.
alter table charts add column caption text not null default '' check (length(caption) <= 500);
alter table charts add column alt text not null default '' check (length(alt) <= 300);

-- Every drawing of a chart: from which version of which data, to what specification, with what
-- tools, giving which files. Rows are never changed, and outlive the chart itself, so a chart
-- file in any revision can be traced to how it was made.
create table chart_draws (
  id bigserial primary key,
  project_id uuid not null references projects on delete cascade,
  name text not null,
  drawn_at timestamptz not null default now(),
  pdf_digest text not null,
  png_digest text not null,
  -- {"data": {"path", "sha256", "columns": [...], "missing": [...]}, "chart": {...},
  --  "rowsLeftOut": 1, "generator": {"vega": "...", "vega-lite": "...", "image": "sha256:..."}}
  record jsonb not null
);
create index chart_draws_chart on chart_draws (project_id, name, id);
