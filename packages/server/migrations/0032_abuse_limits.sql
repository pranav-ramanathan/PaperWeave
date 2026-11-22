-- Each time someone asked for a paper's text to be checked for spelling and grammar: who and
-- when. Nothing of the text. Counted before the check is made, to hold what one person may
-- make the service do (read the file, and ask the checker) in a minute.
create table grammar_requests (
  id bigserial primary key,
  user_id uuid not null references "user" on delete cascade,
  created_at timestamptz not null default now()
);
create index grammar_requests_user on grammar_requests (user_id, created_at);
-- Invitations are counted by the address they went to as well as by who sent them.
create index invitations_email on invitations (email, created_at);
create index thread_comments_author on thread_comments (author, created_at);
create index proposals_author on proposals (author, created_at);
