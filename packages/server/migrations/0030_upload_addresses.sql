-- Each address the browser was given to put an upload in the store: whose, under which key, how
-- many bytes it was signed for, when, and when it was taken. Counted when another is asked for,
-- to hold what one person may leave in the store untaken; marked when taken, so that a key is
-- taken once. Nothing of the file.
create table upload_addresses (
  id bigserial primary key,
  user_id uuid not null references "user" on delete cascade,
  key text not null unique,
  size bigint not null check (size > 0),
  created_at timestamptz not null default now(),
  taken_at timestamptz
);
create index upload_addresses_user on upload_addresses (user_id, created_at);
