-- A proposed edit: replace a stretch of a file's text with other text. It is kept beside the
-- text, not in it, so nothing of it is in the paper (or its PDF) until someone who may edit
-- accepts it.
create table proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  file_id uuid not null references all_files on delete cascade,
  author uuid references "user" on delete set null,
  -- Encoded Yjs relative positions of the stretch, as for threads. Once accepted, they are of
  -- the replacement where it stands, so that the accept can be undone.
  anchor_from bytea not null,
  anchor_to bytea not null,
  -- What the stretch said when the edit was proposed. If it says something else now, the
  -- proposal is stale and is not applied.
  expected text not null,
  replacement text not null,
  reason text not null default '' check (length(reason) <= 1000),
  -- The newest revision of the paper when it was proposed, if there was one.
  base_revision uuid references revisions on delete set null,
  status text not null default 'open'
    check (status in ('open', 'accepted', 'rejected', 'dismissed')),
  decided_by uuid references "user" on delete set null,
  decided_at timestamptz,
  -- The key of the next edit this proposal makes (an accept, or the undoing of one). A retry
  -- of the same step uses the same key and is applied once; each step done sets a new one.
  command_key uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create index proposals_file on proposals (file_id, created_at);
create index proposals_project on proposals (project_id, created_at);
