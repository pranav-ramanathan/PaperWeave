-- When a sign-in link was sent, and to whom, so that one address is only written to so often.
-- The address itself is not kept, only a hash of it: most of these are for people with no
-- account, who never asked to be on record here. Rows are removed after a day.
create table sign_in_links (
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  sent_at timestamptz not null default now()
);
create index sign_in_links_recent on sign_in_links (email_hash, sent_at);
