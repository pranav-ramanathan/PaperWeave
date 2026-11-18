-- The files of a paper. This is the paper's manifest: every change bumps manifest_version.

alter table projects
  add column compiler text not null default 'pdflatex'
    check (compiler in ('pdflatex', 'xelatex', 'lualatex')),
  add column manifest_version integer not null default 1;

create table files (
  -- Stays the same when the file is renamed.
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  path text not null,
  -- The file's bytes in the blob store.
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  size integer not null check (size >= 0),
  -- Set for text the editors can open: the newline style and byte order mark to put back on export.
  eol text check (eol in ('lf', 'crlf')),
  bom boolean,
  -- Otherwise why not: 'binary', 'not-utf8' or 'mixed-newlines'.
  readonly_reason text,
  created_at timestamptz not null default now(),
  unique (project_id, path),
  check ((eol is null) = (bom is null) and (eol is null) = (readonly_reason is not null))
);

alter table projects add column root_file_id uuid references files on delete set null;

-- What the import found, kept so it can be shown again.
create table import_reports (
  project_id uuid primary key references projects on delete cascade,
  report jsonb not null,
  created_at timestamptz not null default now()
);
