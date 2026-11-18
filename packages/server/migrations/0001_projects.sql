-- Projects, who belongs to them, and invitations to join.
-- The "user" table is created by the sign-in library before any of these files run.

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

create table project_members (
  project_id uuid not null references projects on delete cascade,
  user_id uuid not null references "user" on delete cascade,
  role text not null check (role in ('owner', 'editor', 'reviewer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user on project_members (user_id);
-- One corresponding author per project.
create unique index project_members_one_owner on project_members (project_id) where role = 'owner';

create table invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  email text not null check (email = lower(email)),
  role text not null check (role in ('editor', 'reviewer', 'viewer')),
  -- The token is the credential, so only its hash is kept.
  token_hash text not null unique,
  invited_by uuid not null references "user" on delete cascade,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
