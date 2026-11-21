-- A comment can be changed by its author and taken back by its author or the paper's owner. Taking
-- back keeps the row with its text wiped, so that the mention-email limit, which counts comments,
-- cannot be reset by deleting them.
alter table thread_comments add column edited_at timestamptz, add column deleted_at timestamptz;
alter table thread_comments drop constraint thread_comments_body_check;
alter table thread_comments add constraint thread_comments_body_check
  check (length(body) <= 5000 and (deleted_at is not null or length(body) >= 1));
