-- Commands that were applied, so that a command sent twice is applied once.

create table file_commands (
  -- Chosen by the client and sent again unchanged on a retry.
  key uuid primary key,
  file_id uuid not null references all_files on delete cascade,
  user_id uuid references "user" on delete set null,
  created_at timestamptz not null default now()
);
create index file_commands_file on file_commands (file_id, created_at);
