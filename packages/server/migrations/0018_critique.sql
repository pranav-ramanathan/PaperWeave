-- Where a proposed change came from. One made at a person's request by a model review says
-- so, with the model and the version of the claim rules it was checked with, and what in the
-- passage it rests on.
alter table proposals add column origin text not null default 'person'
  check (origin in ('person', 'critique'));
alter table proposals add column made_by text;
alter table proposals add column evidence jsonb not null default '[]';
