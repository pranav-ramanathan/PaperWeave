-- Versions of a paper: a version is a paper of its own, linked to the paper it was started from
-- ("main") and begun at one of main's revisions. Additive only: a paper with no versions is
-- main already, and every new column is null for it. Nothing is migrated.

alter table projects
  -- Set on a version; null on a paper. Deleting the paper deletes its versions.
  add column parent_id uuid references projects on delete cascade,
  -- "camera-ready". The paper's own name is shown beside it.
  add column version_name text check (version_name is null or length(version_name) between 1 and 60),
  -- The revision (of main) both sides last had in common: the one the version began at, then the
  -- source revision of each merge.
  add column base_revision_id uuid references revisions on delete set null,
  add check ((parent_id is null) = (version_name is null));

-- A version's name is its own among the versions of one paper, whatever the capitals.
create unique index projects_version_name on projects (parent_id, lower(version_name))
  where parent_id is not null;
-- Deleting a paper looks for its versions by this (see 0033).
create index projects_parent on projects (parent_id);

-- The file's identity across versions: a copy keeps the origin of the file it was copied from.
-- Null means the file is its own origin, so existing files need no change.
alter table all_files add column origin_id uuid;
create index all_files_origin on all_files (origin_id) where origin_id is not null;
-- The view was made with `select *` before this column existed; it is made again to show it.
create or replace view files as select * from all_files where deleted_at is null;

-- A merge is a revision of its own, as a restore is.
alter table revisions drop constraint revisions_kind_check;
alter table revisions add constraint revisions_kind_check
  check (kind in ('auto', 'named', 'restore', 'merge'));
alter table revisions add column merged_from uuid references revisions on delete set null;
create index revisions_merged_from on revisions (merged_from);
create index projects_base_revision on projects (base_revision_id);

-- The record of each merge: the timeline row, the audit trail and the next base. Counts and ids
-- only; nothing of any text. Not written by anything yet (merging comes after starting).
create table merges (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references projects on delete cascade,
  source_id uuid references projects on delete set null,
  source_revision uuid references revisions on delete set null,
  kept_revision uuid references revisions on delete set null,
  result_revision uuid references revisions on delete set null,
  base_revision uuid references revisions on delete set null,
  files int not null default 0,
  conflicts int not null default 0,
  by uuid references "user" on delete set null,
  at timestamptz not null default now()
);
create index merges_target on merges (target_id, at);
create index merges_source on merges (source_id);
-- Deleting a paper looks for the merges that point at its revisions by these (see 0033).
create index merges_source_revision on merges (source_revision);
create index merges_kept_revision on merges (kept_revision);
create index merges_result_revision on merges (result_revision);
create index merges_base_revision on merges (base_revision);
