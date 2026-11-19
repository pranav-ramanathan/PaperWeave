-- Signing out deletes a session. The sync server is told which, so that editors opened under it
-- stop being served at once, not when their connection next happens to drop. The session table
-- is the sign-in library's; only this trigger on it is ours.
create function notify_session_ended() returns trigger language plpgsql as $$
begin
  perform pg_notify('session_ended', old.id::text);
  return old;
end $$;

create trigger session_ended after delete on session
  for each row execute function notify_session_ended();
