-- A thread or proposal brought across by a merge (PLAN.md section 14, V9) is a copy in the other
-- paper; this names the one it was copied from. It is how a second merge knows not to copy it
-- again, and how a copy is told from a thread that was started where it stands. Additive: null
-- for everything that exists.
alter table threads add column carried_from uuid references threads on delete set null;
alter table proposals add column carried_from uuid references proposals on delete set null;
-- One copy of an item in a paper, even if two merges race.
create unique index threads_carried on threads (project_id, carried_from) where carried_from is not null;
create unique index proposals_carried on proposals (project_id, carried_from) where carried_from is not null;
-- Deleting a thread or proposal looks for its copies by these.
create index threads_carried_from on threads (carried_from);
create index proposals_carried_from on proposals (carried_from);
