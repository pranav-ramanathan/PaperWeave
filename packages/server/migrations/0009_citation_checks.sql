-- Two different things are checked about a citation, and they are recorded apart.

-- 1. Is the entry right? A lookup of its DOI in a public registry: what the registry said, set
--    beside the entry, and when. A lookup is of the entry as it then was.
create table doi_lookups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  key text not null,
  doi text not null,
  -- Where the record came from: 'crossref'.
  source text not null,
  looked_up_at timestamptz not null default now(),
  looked_up_by uuid references "user" on delete set null,
  outcome text not null check (outcome in ('matches', 'differs', 'not_found')),
  -- [{"field": "title", "entry": "...", "registry": "...", "same": true}, ...]
  comparison jsonb not null,
  -- A hash of the fields that were compared. If the entry's now differ, the lookup is out of date.
  entry_digest text not null
);
create index doi_lookups_latest on doi_lookups (project_id, key, looked_up_at desc);

-- 2. Does the source support what the paper says of it? A person's judgement about one claim,
--    which is quoted. A right entry says nothing about this, and this says nothing about the entry.
create table evidence_checks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  key text not null,
  claim text not null check (length(claim) between 1 and 2000),
  verdict text not null check (verdict in ('supports', 'partly', 'does_not_support')),
  note text check (note is null or length(note) <= 2000),
  checked_by uuid references "user" on delete set null,
  checked_at timestamptz not null default now()
);
create index evidence_checks_by_key on evidence_checks (project_id, key, checked_at);
