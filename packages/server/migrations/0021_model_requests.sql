-- Each time a model was asked to review a passage: which paper, who asked, when. Nothing of
-- the passage. For holding the number of requests a paper makes in an hour to a limit.
create table model_requests (
  id bigserial primary key,
  project_id uuid not null references projects on delete cascade,
  user_id uuid references "user" on delete set null,
  created_at timestamptz not null default now()
);
create index model_requests_project on model_requests (project_id, created_at);
