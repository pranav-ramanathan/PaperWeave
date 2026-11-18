-- A thread of comments about a stretch of a file's text. The stretch is held as two Yjs
-- positions, so it moves with the text as people edit around and inside it.
create table threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  file_id uuid not null references all_files on delete cascade,
  -- Encoded Yjs relative positions: the start holds on to the character after it, the end to
  -- the one before it.
  anchor_from bytea not null,
  anchor_to bytea not null,
  -- What the thread was started on, and a little of what stood before and after it then. Kept
  -- so that a thread whose text is deleted still says what it was about.
  excerpt text not null,
  context_before text not null default '',
  context_after text not null default '',
  -- The sha256 of the whole stretch as it was, to see that it has been changed since.
  fingerprint text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_by uuid references "user" on delete set null,
  created_at timestamptz not null default now(),
  resolved_by uuid references "user" on delete set null,
  resolved_at timestamptz
);
create index threads_file on threads (file_id, created_at);
create index threads_project on threads (project_id, created_at);

create table thread_comments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads on delete cascade,
  author uuid references "user" on delete set null,
  body text not null check (length(body) between 1 and 5000),
  -- The people of the paper this comment was addressed to.
  mentions uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index thread_comments_thread on thread_comments (thread_id, created_at);
