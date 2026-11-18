-- A revision is the paper at one moment: every file's path and bytes, the root and the compiler.
-- It never changes. Builds and exports read revisions, never the live text.

create table revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  -- 1, 2, 3... within the paper.
  number integer not null,
  name text check (name is null or length(name) between 1 and 200),
  -- auto: cut for a build or a download. named: saved by a person. restore: made by restoring.
  kind text not null check (kind in ('auto', 'named', 'restore')),
  restored_from uuid references revisions on delete set null,
  root text,
  compiler text not null,
  -- A hash of everything above that affects the output. Equal keys mean identical content.
  content_key text not null,
  created_by uuid references "user" on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, number)
);

create table revision_files (
  revision_id uuid not null references revisions on delete cascade,
  -- Not a foreign key: a revision outlives changes to the live file list.
  file_id uuid not null,
  path text not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  -- How far the file's edit log had got.
  seq bigint not null,
  primary key (revision_id, file_id)
);

-- Every build is of one revision. What went in is now read from there.
alter table builds
  add column revision_id uuid references revisions on delete cascade,
  drop column inputs,
  drop column heads;

-- One waiting build of the latest text per paper, and one per revision asked for by name.
drop index builds_one_queued;
create unique index builds_one_queued on builds
  (project_id, coalesce(revision_id, '00000000-0000-0000-0000-000000000000'))
  where status = 'queued';
