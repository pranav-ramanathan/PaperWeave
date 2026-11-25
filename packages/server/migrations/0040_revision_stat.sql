-- What changed in a revision against the one before it: words added and removed, files changed
-- (`revisionStats`). Worked out once and kept, since a revision never changes. Null until it is:
-- revisions from before are not counted by this migration (that would read every file of every
-- revision of every paper); they are counted the first time their count is asked for.
alter table revisions add column stat jsonb;
