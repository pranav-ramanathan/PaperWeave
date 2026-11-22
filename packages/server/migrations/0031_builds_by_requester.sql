-- Builds are counted, and taken in turn, by who asked for them: how many one person has waiting
-- or asked for in the last hour (`requestBuild`), and whose build the worker takes next.
create index builds_requester on builds (requested_by, created_at);
