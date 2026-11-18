-- Every edit to a file, in the order the server accepted it. An edit is acknowledged to its
-- author only after its row here is committed.

alter table files add column head_seq bigint not null default 0;

create table file_updates (
  file_id uuid not null references files on delete cascade,
  seq bigint not null,
  -- A Yjs update. The first one for a file is written by the server from the file's bytes.
  update bytea not null,
  user_id uuid references "user" on delete set null,
  created_at timestamptz not null default now(),
  primary key (file_id, seq)
);
