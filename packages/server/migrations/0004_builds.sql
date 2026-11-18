-- Builds of a paper. This table is also the job queue: a worker takes the oldest queued row with
-- "for update skip locked" and holds it until the build is done, so a worker that dies gives
-- the job back by losing its lock.

create table builds (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  requested_by uuid references "user" on delete set null,
  status text not null default 'queued' check (status in ('queued', 'succeeded', 'failed')),
  -- Everything that can change the output, hashed: files, root, compiler, toolchain image.
  cache_key text,
  -- path -> digest of every file that went in, and file id -> how far its edit log had got.
  inputs jsonb,
  heads jsonb,
  compiler text,
  image text,
  -- Set when an earlier build with the same cache key supplied the result.
  cached_from uuid references builds on delete set null,
  diagnostics jsonb,
  timed_out boolean,
  pdf_digest text,
  synctex_digest text,
  log_digest text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index builds_project on builds (project_id, created_at desc);
-- Asking again while a build is waiting does not queue another.
create unique index builds_one_queued on builds (project_id) where status = 'queued';
