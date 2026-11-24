-- Deleting a paper (`deleteProject`) deletes its row, and everything that hangs off it follows
-- through the foreign keys. For each row that goes, the database looks for the rows that point
-- at it; without an index on the pointing column it reads that whole table every time. Measured
-- on a development database of 17,000 papers: 45 s for a paper of 5,000 revisions and 10,000
-- builds, 10 s for one of 2,000 files; with these, 0.6 s and 0.3 s.
create index projects_root_file on projects (root_file_id);
create index all_files_project on all_files (project_id);
create index invitations_project on invitations (project_id);
create index builds_cached_from on builds (cached_from);
create index builds_revision on builds (revision_id);
create index revisions_restored_from on revisions (restored_from);
create index proposals_base_revision on proposals (base_revision);
create index charts_dataset_file on charts (dataset_file_id);
