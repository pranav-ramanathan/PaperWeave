-- Review brought in from an archive was written by people who may have no account here. Their
-- names are kept as text, beside the author column that is then empty.
alter table threads add column imported_author text;
alter table thread_comments add column imported_author text;
alter table proposals add column imported_author text;
