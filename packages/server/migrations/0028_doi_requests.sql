-- Each time the service asked the DOI registry about a paper's entry: which paper, who asked,
-- when. Nothing of the entry. Counted before asking, so that a request that fails still counts,
-- for holding what one person and one paper may make the registry answer to a limit.
create table doi_requests (
  id bigserial primary key,
  project_id uuid not null references projects on delete cascade,
  user_id uuid references "user" on delete set null,
  created_at timestamptz not null default now()
);
create index doi_requests_project on doi_requests (project_id, created_at);
create index doi_requests_user on doi_requests (user_id, created_at);
