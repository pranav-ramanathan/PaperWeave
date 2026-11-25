-- Charts are counted, and taken in turn, by who asked for them, as builds are (migration 0031):
-- how many one person has waiting or asked for in the last hour (`saveChart`), and whose chart
-- the worker draws next (`drawNext`). `charts.asked_at` is when a drawing was last asked for; the
-- worker takes the oldest of those, not the oldest chart. Rows from before have no requester: the
-- worker treats them as one group of their own.
alter table chart_requests add column user_id uuid references "user" on delete set null;
alter table charts add column requested_by uuid references "user" on delete set null;
alter table charts add column asked_at timestamptz not null default now();
update charts set asked_at = created_at;
create index chart_requests_by_user on chart_requests (user_id, created_at);
-- The queue, and what each requester has waiting or has had drawn in the last hour.
create index charts_queued_asked on charts (asked_at) where status = 'queued';
create index charts_requester on charts (requested_by, asked_at);
