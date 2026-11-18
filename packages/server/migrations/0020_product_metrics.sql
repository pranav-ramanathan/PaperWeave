-- For counting how papers fare. Counts only: nothing here says what a paper holds.

-- Each download of a paper, as a ZIP or as a PDF.
create table downloads (
  id bigserial primary key,
  project_id uuid not null references projects on delete cascade,
  kind text not null check (kind in ('zip', 'pdf')),
  created_at timestamptz not null default now()
);
create index downloads_project on downloads (project_id, kind);

-- Who has edited a paper. The edit log says so too, until it is compacted; this remembers.
create table project_authors (
  project_id uuid not null references projects on delete cascade,
  user_id uuid not null references "user" on delete cascade,
  first_seen timestamptz not null default now(),
  primary key (project_id, user_id)
);
