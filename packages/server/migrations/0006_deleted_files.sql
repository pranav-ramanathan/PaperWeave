-- Deleting a file hides it; the row and its edit log stay. Restoring a revision brings the same
-- file back with its history, so someone who had it open merges cleanly instead of doubling text.

alter table files rename to all_files;
alter table all_files add column deleted_at timestamptz;

-- Only live files compete for a name.
alter table all_files drop constraint files_project_id_path_key;
create unique index files_live_path on all_files (project_id, path) where deleted_at is null;

-- Every query that says "files" sees live files only. Inserts and updates pass through.
create view files as select * from all_files where deleted_at is null;
