-- What became of the grammar checker's findings, in counts: how often a finding of each kind was
-- taken up, proposed, made one of the paper's words, or had its rule switched off. Only these
-- names are kept, never the words or the rule, so that nothing of a paper is in it.
create table grammar_outcomes (
  project_id uuid not null references projects (id) on delete cascade,
  kind text not null check (kind in ('spelling', 'grammar', 'style')),
  outcome text not null check (outcome in ('changed', 'proposed', 'word', 'rule_off')),
  count int not null default 0,
  primary key (project_id, kind, outcome)
);
