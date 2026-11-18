-- Each time a chart is asked to be drawn. Every drawing runs a sandbox, so a paper's charts
-- are drawn only so often in an hour, and this is what is counted. (chart_draws cannot be: a
-- drawing that gives the same files as before is not recorded there again.) Rows older than a
-- day are removed as new ones are added.
create table chart_requests (
  project_id uuid not null references projects on delete cascade,
  created_at timestamptz not null default now()
);
create index chart_requests_recent on chart_requests (project_id, created_at);
