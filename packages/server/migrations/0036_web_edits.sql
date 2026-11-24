-- Each time a person rewrote text through the web app (a restore, replacing a file): who, on which
-- paper, and how many bytes of edits it added (at least the floor). Nothing of the text. Summed
-- over the last hour for holding what one person may rewrite to a budget, in the database because
-- more than one web app may run. A row stays when its paper is deleted, so that deleting
-- a paper does not give the budget back.
create table web_edits (
  id bigserial primary key,
  user_id uuid not null references "user" on delete cascade,
  project_id uuid references projects on delete set null,
  bytes bigint not null,
  created_at timestamptz not null default now()
);
create index web_edits_user on web_edits (user_id, created_at);
