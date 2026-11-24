-- web_edits.project_id references projects on delete set null (0036), so deleting a paper
-- (`deleteProject`) looks up the web_edits rows that point at it. Without an index on the
-- pointing column that reads the whole table for every paper deleted, as 0033 found for the others.
create index web_edits_project on web_edits (project_id);
