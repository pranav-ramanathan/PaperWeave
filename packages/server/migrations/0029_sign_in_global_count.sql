-- The count of every sign-in email sent in the last hour reads by time alone.
create index sign_in_links_sent on sign_in_links (sent_at);
